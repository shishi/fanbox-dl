import { zipSync } from "fflate";
import { bytesToBase64 } from "../core/base64";
import { renderTemplate } from "../core/template-engine";
import { validateMediaUrl } from "../core/url-allowlist";
import { CONFLICT_ACTION } from "../core/settings";
import { validatePath } from "../core/path-validator";
import { buildRenderContext, buildZipRenderContext } from "./render-adapter";
import { filenameGuard } from "./filename-guard";
import { OFFSCREEN_TARGET } from "../offscreen/protocol";
import type { OffscreenAbortMessage, OffscreenChunkMessage, OffscreenDoneMessage, OffscreenRevokeMessage, OffscreenResult } from "../offscreen/protocol";
import type { ContentBlock, PostData, Settings } from "../core/types";

// spec §7b: 事前チェックと実行時バジェットは同一の名前付き定数を参照する
export const ZIP_SOURCE_BUDGET_BYTES = 100 * 1024 * 1024;
export const ZIP_MAX_FILES = 100;
const ZIP_CHUNK_BYTES = 4 * 1024 * 1024;

// spec §7b の必須文言 2 種。フォールバック文は click 通知用、リトライ文は click 通知への
// 併記と blob DL 発行後の console ログ(配達経路が異なる 2 契約を別定数で保持)
export const ZIP_FALLBACK_WORDING = "この投稿(の一部)は zip にできないため個別ダウンロードに切り替えました";
export const ZIP_RETRY_WORDING = "zip は最初からやり直し。確実性が要るなら通常 DL を。";

export function zipEligible(block: ContentBlock, s: Settings): boolean {
  return block.contentType === "photo" && block.files.length >= 2 && s.zipGalleries && s.contentTypes.photo;
}

export interface ChunkedResponse {
  ok: boolean; status: number;
  chunks(): AsyncIterable<Uint8Array>;
  abort(): void;
}
type BinFetch = (url: string, init?: RequestInit) => Promise<ChunkedResponse>;

// 実 fetch を ChunkedResponse に包む(ReadableStream をチャンク単位で読む)
function realBinFetch(url: string, init?: RequestInit): Promise<ChunkedResponse> {
  return fetch(url, init).then((res) => {
    const reader = res.body?.getReader();
    return {
      ok: res.ok, status: res.status,
      async *chunks() {
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      },
      abort: () => { void reader?.cancel().catch(() => {}); },
    };
  });
}

export async function collectZipSources(
  files: Array<{ url: string; size?: number }>, postId: string,
  deps: { fetchFn?: BinFetch; budget?: number } = {},
): Promise<{ ok: true; buffers: Map<string, Uint8Array> } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? realBinFetch;
  const budget = deps.budget ?? ZIP_SOURCE_BUDGET_BYTES;
  if (files.length > ZIP_MAX_FILES) return { ok: false, error: `zip 件数上限(${ZIP_MAX_FILES})超過` };
  // spec §7b(a): サイズ既知の item の合計での事前チェック(1 バイトも fetch せずに拒否)
  const knownTotal = files.reduce((n, f) => n + (typeof f.size === "number" ? f.size : 0), 0);
  if (knownTotal > budget) return { ok: false, error: `zip ソース既知サイズ合計がバイト上限(${budget})を超過` };
  const buffers = new Map<string, Uint8Array>();
  let used = 0;
  for (const f of files) {
    const v = validateMediaUrl(f.url, postId); // spec §4a: zip ソース fetch も allowlist 必須
    if (!v.ok) return { ok: false, error: v.error };
    let r: ChunkedResponse;
    try {
      // spec §4a-3: リダイレクトは allowlist を抜け得るため fail-closed(realBinFetch は throw → catch で error)
      r = await fetchFn(f.url, { credentials: "include", redirect: "error" });
    } catch (e) {
      return { ok: false, error: `zip ソース取得に失敗: ${String(e)}` };
    }
    if (!r.ok) return { ok: false, error: `zip ソース取得が status ${r.status}` };
    // spec §7b: 累積受信バイトをチャンク単位で計上し、超えた「時点」で abort して中止
    // (超過分をメモリに保持しない)。
    const parts: Uint8Array[] = [];
    let over = false;
    for await (const chunk of r.chunks()) {
      used += chunk.byteLength;
      if (used > budget) { over = true; r.abort(); break; }
      parts.push(chunk);
    }
    if (over) return { ok: false, error: `zip ソース合計がバイト上限(${budget})を超過したため中止` };
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.byteLength; }
    buffers.set(f.url, buf);
  }
  return { ok: true, buffers };
}

export function buildZip(
  post: PostData, block: ContentBlock, buffers: Map<string, Uint8Array>, s: Settings, now: Date,
): { zipPath: string; bytes: Uint8Array } {
  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  for (const f of block.files) {
    const buf = buffers.get(f.url);
    // spec §7b: 黙った欠落の禁止。ソースが揃っていない zip は組み立てず error にして
    // 呼び出し側の個別 DL フォールバックに乗せる。
    if (!buf) throw new Error(`zip ソース欠落: ${f.url}`);
    const ctx = buildRenderContext(post, block, f, now);
    let entryPath = renderTemplate(s.zipEntryTemplate, ctx, { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    // テンプレが $seq を含まない等の衝突 -> 静かな上書きを防ぐため連番(fantia-dl と同一規則)
    if (usedNames.has(entryPath)) {
      const dot = entryPath.lastIndexOf(".");
      const stem = dot > 0 ? entryPath.slice(0, dot) : entryPath;
      const ext = dot > 0 ? entryPath.slice(dot) : "";
      let n = 2;
      let candidate = `${stem} (${n})${ext}`;
      while (usedNames.has(candidate)) { n++; candidate = `${stem} (${n})${ext}`; }
      entryPath = candidate;
    }
    // 最終レビュー round5 P2c: zipPath は呼び出し側(orchestrator)で download 前に
    // validatePath されるが、各 entryPath はここまで無検証で archive に書かれていた。
    // 古い同期設定等で zipEntryTemplate 自体に不正なパス片が残っていた場合に備え、
    // zipPath と同じ検証を entryPath にも適用し、fail-closed で throw する
    // (呼び出し側の個別 DL フォールバックに乗せるため、ここで握りつぶさない)。
    // codex レビュー round5 指摘: zip 内部のエントリ名は chrome.downloads の
    // uniquify サフィックス付与対象ではない(実ファイルシステムパスではない)ため、
    // conflictAction:"uniquify" 前提の uniquifyHeadroom をここで引いてはいけない
    // (引くと実際には収まる長さの entry まで誤って拒否してしまう)。
    const pv = validatePath(entryPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: "overwrite", segmentMaxLen: s.segmentMaxLen });
    if (!pv.ok) throw new Error(`zip entryPath 不正: ${entryPath}: ${pv.error}`);
    usedNames.add(entryPath);
    entries[entryPath] = buf;
  }
  const zipCtx = buildZipRenderContext(post, block, now);
  const zipPath = renderTemplate(s.zipPathTemplate, zipCtx, { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
  return { zipPath, bytes: zipSync(entries) };
}

// --- 以下、offscreen 経由の blob DL(fantia-dl service-worker.ts の zip 部分を移植) ---
const zipDownloads = new Map<number, string>(); // downloadId -> blobUrl のインメモリキャッシュ
const ZIP_DOWNLOADS_STORAGE_KEY = "zipDownloads";

async function persistZipDownloads(): Promise<void> {
  await chrome.storage.session.set({ [ZIP_DOWNLOADS_STORAGE_KEY]: Object.fromEntries(zipDownloads) });
}

async function loadZipDownloads(): Promise<void> {
  const r = await chrome.storage.session.get(ZIP_DOWNLOADS_STORAGE_KEY);
  const obj = (r?.[ZIP_DOWNLOADS_STORAGE_KEY] as Record<string, string>) ?? {};
  for (const [id, url] of Object.entries(obj)) zipDownloads.set(Number(id), url);
}

let offscreenReadyPromise: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenReadyPromise) {
    offscreenReadyPromise = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen/offscreen.html"),
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "zip Blob を組み立てて downloads.download 用の object URL を作るため(Service Worker には URL.createObjectURL が無い)",
      });
    })().catch((e) => {
      offscreenReadyPromise = null;
      throw e;
    });
  }
  return offscreenReadyPromise;
}

function sendChunkToOffscreen(jobId: string, base64: string): Promise<unknown> {
  return chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "zipChunk", jobId, base64,
  } satisfies OffscreenChunkMessage);
}

// content-script 側と同じ役目: zipDone に届く前に送信ループが失敗した場合、
// offscreen document の accumulators に溜まったチャンクを破棄させる(spec §7b: リーク防止)。
function sendZipAbort(jobId: string): Promise<unknown> {
  return chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "zipAbort", jobId,
  } satisfies OffscreenAbortMessage).catch(() => {});
}

interface ZipPortResult {
  queued: number;
  error?: string;
}

async function finishZipDownload(jobId: string, filename: string): Promise<ZipPortResult> {
  const res = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "zipDone", jobId, mimeType: "application/zip",
  } satisfies OffscreenDoneMessage)) as OffscreenResult | undefined;

  if (!res || !res.ok) {
    return { queued: 0, error: res?.error ?? "offscreen document から応答がありませんでした" };
  }

  const blobUrl = res.url;
  try {
    // 通常 DL と同じく、blob DL も onDeterminingFilename の横取り対象になる
    // (登録済みの他拡張が居ると zipPathTemplate の結果が捨てられる)。
    // 発行口を filenameGuard に通してテンプレ名を再主張できるようにする。
    const downloadId = await filenameGuard.claimAndDownload(blobUrl, filename, () =>
      chrome.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: CONFLICT_ACTION }));
    zipDownloads.set(downloadId, blobUrl);
    await persistZipDownloads();
    return { queued: 1 };
  } catch (e) {
    await revokeOffscreenUrl(blobUrl);
    return { queued: 0, error: String(e) };
  }
}

function revokeOffscreenUrl(url: string): Promise<unknown> {
  return chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "revoke", url,
  } satisfies OffscreenRevokeMessage).catch(() => {});
}

// downloadZipViaOffscreen のテストのための注入点。既定は実 chrome API を使う実装。
export interface ZipOffscreenDeps {
  ensureOffscreen(): Promise<void>;
  sendChunk(jobId: string, base64: string): Promise<unknown>;
  finish(jobId: string, filename: string): Promise<ZipPortResult>;
  abort(jobId: string): Promise<unknown>;
}

const defaultZipOffscreenDeps: ZipOffscreenDeps = {
  ensureOffscreen: ensureOffscreenDocument,
  sendChunk: sendChunkToOffscreen,
  finish: finishZipDownload,
  abort: sendZipAbort,
};

export async function downloadZipViaOffscreen(
  zipPath: string, bytes: Uint8Array, deps: ZipOffscreenDeps = defaultZipOffscreenDeps,
): Promise<{ ok: boolean; error?: string }> {
  await deps.ensureOffscreen();
  const jobId = crypto.randomUUID();
  try {
    for (let off = 0; off < bytes.byteLength; off += ZIP_CHUNK_BYTES) {
      await deps.sendChunk(jobId, bytesToBase64(bytes.subarray(off, Math.min(off + ZIP_CHUNK_BYTES, bytes.byteLength))));
    }
    const res = await deps.finish(jobId, zipPath);
    return res.queued === 1 ? { ok: true } : { ok: false, error: res.error };
  } catch (e) {
    // zipDone(finish)まで届かなかった=offscreen の accumulators に蓄積が居座ったままになるため、
    // zipAbort で破棄させてからエラーを返す(spec §7b: 途中失敗での offscreen リーク防止)。
    await deps.abort(jobId);
    return { ok: false, error: String(e) };
  }
}

// --- handleZipDownloadChange と registerZipDownload の deps 注入インタフェース ---
export interface ZipChangeDeps {
  revoke(url: string): Promise<unknown>;
  log(msg: string): void;
  persist(): Promise<void>;
}

export function registerZipDownload(downloadId: number, blobUrl: string, deps?: ZipChangeDeps): void {
  zipDownloads.set(downloadId, blobUrl);
}

export async function handleZipDownloadChange(
  delta: chrome.downloads.DownloadDelta, deps?: ZipChangeDeps,
): Promise<boolean> {
  const { id, state } = delta;
  if (!id) return false;
  const blobUrl = zipDownloads.get(id);
  if (!blobUrl) return false;

  const d = deps ?? { revoke: revokeOffscreenUrl, log: console.error, persist: persistZipDownloads };
  if (state?.current === "interrupted") {
    zipDownloads.delete(id);
    await d.revoke(blobUrl);
    d.log(`[fanbox-dl] zip のダウンロードに失敗しました。${ZIP_RETRY_WORDING}`);
    await d.persist();
    return true;
  }
  if (state?.current === "complete") {
    zipDownloads.delete(id);
    await d.revoke(blobUrl);
    await d.persist();
    return true;
  }
  return false;
}

export async function reconcileZipDownloads(): Promise<void> {
  await loadZipDownloads();
  // 起動時: storage.session から復元した zipDownloads をオンメモリキャッシュとして使用
  // これ以降の中断チェックや revoke で使われる
}
