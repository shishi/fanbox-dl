### Task 14: zip モジュール(SW fetch + バジェット + offscreen 経路)(spec §7b)

**Files:**
- Create: `src/background/zip.ts`
- Create: `src/offscreen/protocol.ts`(fantia-dl から無改造コピー)
- Create: `src/offscreen/offscreen.ts`(fantia-dl から無改造コピー)
- Create: `public/offscreen/offscreen.html`(fantia-dl から無改造コピー)
- Test: `tests/zip.test.ts`

**Interfaces:**
- Consumes: `ContentBlock / Settings / PostData`(Task 3)、`validateMediaUrl`(Task 5)、`buildRenderContext / buildZipRenderContext`(Task 6)、`bytesToBase64`(Task 1)、`renderTemplate`(Task 1)
- Produces(Task 15 の SW が使う):

```ts
export const ZIP_SOURCE_BUDGET_BYTES: number; // 100 * 1024 * 1024
export const ZIP_MAX_FILES: number;           // 100
export function zipEligible(block: ContentBlock, s: Settings): boolean;
export interface ChunkedResponse { ok: boolean; status: number; chunks(): AsyncIterable<Uint8Array>; abort(): void }
export function collectZipSources(
  files: Array<{ url: string; idemKey: string; size?: number }>, postId: string,
  deps: { fetchFn?: (url: string, init?: RequestInit) => Promise<ChunkedResponse>; budget?: number },
): Promise<{ ok: true; buffers: Map<string, Uint8Array> } | { ok: false; error: string }>;
  // (a) 事前チェック: サイズ既知(size がある)item の合計が budget 超過なら fetch せず即 error
  // (b) 実行時: 累積受信バイト数をチャンク単位で計上し、budget を超えた「時点」で abort() して中止
  // (spec §7b 二段構え。読み切ってから判定するのは禁止 — 超過分をメモリに保持しないため)
export function buildZip(post: PostData, block: ContentBlock, buffers: Map<string, Uint8Array>, s: Settings, now: Date): { zipPath: string; bytes: Uint8Array };
export function downloadZipViaOffscreen(zipPath: string, bytes: Uint8Array): Promise<{ ok: boolean; error?: string }>;
export const ZIP_FALLBACK_WORDING: string; // spec §7b「zip にできないため個別ダウンロードに切り替えました」(click 通知)
export const ZIP_RETRY_WORDING: string;    // spec §7b「zip は最初からやり直し…」(click 通知への併記 + console ログ)
export interface ZipChangeDeps { revoke(url: string): Promise<unknown>; log(msg: string): void; persist(): Promise<void> }
export function registerZipDownload(downloadId: number, blobUrl: string, deps?: ZipChangeDeps): void;
export function handleZipDownloadChange(delta: chrome.downloads.DownloadDelta, deps?: ZipChangeDeps): Promise<boolean>;
  // zip 由来なら処理して true。interrupted は revoke + ZIP_RETRY_WORDING を含む log(spec §7b 配達経路)。
  // deps 既定値は { revoke: revokeOffscreenUrl, log: console.error, persist: persistZipDownloads }
export function reconcileZipDownloads(): Promise<void>;                                            // 起動時
```

**実装指針**:
- `zipEligible` = `block.contentType === "photo" && block.files.length >= 2 && s.zipGalleries && s.contentTypes.photo`(spec §7b)
- `collectZipSources`: 件数 > ZIP_MAX_FILES で即 error(preflight)。各 URL を `validateMediaUrl` してから **直列に** `fetch(url, {credentials: "include"})`。累積バイトが budget 超過で中止 error(spec §7b 実行時バジェット)
- `buildZip`: fantia-dl の `makeAndDownloadZipInner` のエントリ名生成(zipEntryTemplate + 衝突時 " (n)" 連番)と `zipSync` をそのまま移植。zip パスは `buildZipRenderContext` + `s.zipPathTemplate` で導出
- `downloadZipViaOffscreen` / `handleZipDownloadChange` / `reconcileZipDownloads`: fantia-dl service-worker.ts の zip 部分(ensureOffscreenDocument / sendChunkToOffscreen / finishZipDownload / revokeOffscreenUrl / zipDownloads の storage.session 永続化 / 起動時 reconcile)を **そのまま移植**して zip.ts に納める。チャンク送信は SW 内で `bytesToBase64` して 4MB ごとに offscreen へ(fantia の Port 経由チャンクは content→SW 用だったが、fanbox は SW 起点なので Port は不要。SW から `sendChunkToOffscreen` を直接ループで呼ぶ)。`conflictAction` は `CONFLICT_ACTION` 定数
- **フォールバックは呼び出し側(Task 15)の責務**: この module は失敗を error で返すだけ。SW が「zip 不成立 → 同ブロックを個別 DL に enqueue + 非致命通知」を実装する(spec §7b の唯一のフォールバック規定)

- [ ] **Step 1: 純粋部分の失敗テストを書く**

`tests/zip.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { zipEligible, collectZipSources, buildZip, ZIP_SOURCE_BUDGET_BYTES, ZIP_MAX_FILES } from "../src/background/zip";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import type { ContentBlock, FileItem } from "../src/core/types";

const item = (id: string): FileItem => ({
  contentType: "photo", url: `https://downloads.fanbox.cc/images/post/1/${id}.jpg`,
  filename: id, ext: "jpg", seq: 1, total: 1, idemKey: `1:image:${id}`,
  stableContentId: `image:${id}`, refetch: { postId: "1", stableContentId: `image:${id}`, index: 0 },
});
const block = (n: number): ContentBlock => ({
  blockOrdinal: 1, contentType: "photo",
  files: Array.from({ length: n }, (_, i) => item(`f${i}`)),
});

describe("zipEligible (spec §7b)", () => {
  it("photo かつ 2 枚以上かつ zipGalleries ON で true", () => {
    expect(zipEligible(block(2), DEFAULT_SETTINGS)).toBe(true);
  });
  it("単発 photo は false(個別 DL の耐久性を優先)", () => {
    expect(zipEligible(block(1), DEFAULT_SETTINGS)).toBe(false);
  });
  it("zipGalleries OFF / photo フィルタ OFF で false", () => {
    expect(zipEligible(block(2), { ...DEFAULT_SETTINGS, zipGalleries: false })).toBe(false);
    expect(zipEligible(block(2), { ...DEFAULT_SETTINGS, contentTypes: { ...DEFAULT_SETTINGS.contentTypes, photo: false } })).toBe(false);
  });
  it("file ブロックは false", () => {
    expect(zipEligible({ ...block(2), contentType: "file" }, DEFAULT_SETTINGS)).toBe(false);
  });
});

describe("collectZipSources (spec §7b バジェット)", () => {
  // chunkSizes を順に流すモック。abort されたら以降のチャンクを出さない
  const chunked = (chunkSizes: number[], status = 200) => {
    const state = { aborted: false, yielded: 0 };
    const resp = {
      ok: status === 200, status,
      async *chunks() {
        for (const n of chunkSizes) {
          if (state.aborted) return;
          state.yielded += n;
          yield new Uint8Array(n);
        }
      },
      abort: () => { state.aborted = true; },
    };
    return { resp, state };
  };
  it("直列 fetch して buffers を返す", async () => {
    const r = await collectZipSources(block(2).files, "1", { fetchFn: async () => chunked([10]).resp });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.buffers.size).toBe(2);
  });
  it("累積バイトが budget を超えた時点で abort して中止 error(読み切らない) (spec §7b)", async () => {
    const states: Array<{ aborted: boolean; yielded: number }> = [];
    const r = await collectZipSources(block(1).files, "1", {
      fetchFn: async () => { const { resp, state } = chunked([60, 60, 60]); states.push(state); return resp; },
      budget: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("上限");
    // 2 チャンク目(累積 120 > 100)で中止し、3 チャンク目は受信していない
    expect(states[0].yielded).toBe(120);
    expect(states[0].aborted).toBe(true);
  });
  it("事前チェック: 既知サイズ合計が budget 超過なら 1 バイトも fetch せず error (spec §7b(a))", async () => {
    let called = 0;
    const files = block(2).files.map((f, i) => ({ ...f, size: 80 }));
    const r = await collectZipSources(files, "1", { fetchFn: async () => { called++; return chunked([1]).resp; }, budget: 100 });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });

  it("件数上限超過は fetch せず即 error", async () => {
    let called = 0;
    const files = Array.from({ length: ZIP_MAX_FILES + 1 }, (_, i) => item(`f${i}`));
    const r = await collectZipSources(files, "1", { fetchFn: async () => { called++; return chunked([1]).resp; } });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });
  it("allowlist 違反 URL は fetch せず error (spec §4a: zip ソース fetch も対象)", async () => {
    const bad = { ...item("x"), url: "https://evil.example.com/images/post/1/x.jpg" };
    const r = await collectZipSources([bad], "1", { fetchFn: async () => chunked([1]).resp });
    expect(r.ok).toBe(false);
  });
  it("fetch 失敗(403 等)は error", async () => {
    const r = await collectZipSources(block(2).files, "1", { fetchFn: async () => chunked([], 403).resp });
    expect(r.ok).toBe(false);
  });
  it("既定 budget は 100MB", () => {
    expect(ZIP_SOURCE_BUDGET_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe("buildZip (spec §7b 黙った欠落の禁止)", () => {
  const post = {
    postId: "1", postTitle: "T", creator: "C", creatorId: "s", fee: 0,
    publishedAt: new Date("2026-07-01T00:00:00Z"), updatedAtIso: "", restricted: false,
    postType: "image", skippedEmbeds: 0, contents: [],
  } as any;
  it("ソース buffer が欠けていたら throw(呼び出し側の個別 DL フォールバックに乗せる)", () => {
    const b = block(2);
    const buffers = new Map([[b.files[0].idemKey, new Uint8Array(1)]]); // 2 本目が欠落
    expect(() => buildZip(post, b, buffers, DEFAULT_SETTINGS, new Date())).toThrow(/欠落/);
  });
  it("エントリ名衝突は ' (n)' 連番で回避される(静かな上書き禁止)", () => {
    const b = block(2);
    // $seq を含まないテンプレで両ファイルが同名になる状況を作る
    const s = { ...DEFAULT_SETTINGS, zipEntryTemplate: "$filename.$ext" };
    b.files = b.files.map((f) => ({ ...f, filename: "same" }));
    const buffers = new Map(b.files.map((f) => [f.idemKey, new Uint8Array(1)]));
    const { bytes } = buildZip(post, b, buffers, s, new Date());
    // fantia-dl と同一の " (n)" 規則をエントリ名で直接検証する
    const entries = Object.keys(unzipSync(bytes));
    expect(entries.sort()).toEqual(["same (2).jpg", "same.jpg"]);
  });
});

(buildZip テストのため import に `buildZip` と型を追加する)

さらに `handleZipDownloadChange` の配達経路テストを追加する(deps 注入版):

```ts
describe("handleZipDownloadChange (spec §7b 途中失敗の配達経路)", () => {
  it("登録済み zip DL の interrupted は revoke + 必須文言の console ログ", async () => {
    const revoked: string[] = [];
    const logs: string[] = [];
    const deps = { revoke: async (u: string) => { revoked.push(u); }, log: (m: string) => { logs.push(m); }, persist: async () => {} };
    registerZipDownload(42, "blob:xyz", deps);
    const handled = await handleZipDownloadChange({ id: 42, state: { current: "interrupted", previous: "in_progress" } } as any, deps);
    expect(handled).toBe(true);
    expect(revoked).toEqual(["blob:xyz"]);
    expect(logs.some((m) => m.includes("zip は最初からやり直し。確実性が要るなら通常 DL を。"))).toBe(true);
  });
  it("complete は revoke のみでエラーログを出さない", async () => {
    const revoked: string[] = [];
    const logs: string[] = [];
    const deps = { revoke: async (u: string) => { revoked.push(u); }, log: (m: string) => { logs.push(m); }, persist: async () => {} };
    registerZipDownload(43, "blob:ok", deps);
    const handled = await handleZipDownloadChange({ id: 43, state: { current: "complete", previous: "in_progress" } } as any, deps);
    expect(handled).toBe(true);
    expect(revoked).toEqual(["blob:ok"]);
    expect(logs).toEqual([]);
  });
  it("未登録の downloadId は false(通常 DL の onChanged 処理へ)", async () => {
    expect(await handleZipDownloadChange({ id: 999, state: { current: "complete", previous: "x" } } as any, { revoke: async () => {}, log: () => {}, persist: async () => {} })).toBe(false);
  });
});
```

(このため zip.ts は `registerZipDownload(downloadId, blobUrl, deps?)` を export し、
`handleZipDownloadChange(delta, deps?)` は `deps = { revoke: revokeOffscreenUrl,
log: console.error, persist: persistZipDownloads }` を既定値とする。
import 行にも `registerZipDownload, handleZipDownloadChange` を追加)
```

- [ ] **Step 2: 失敗を確認 → offscreen をコピー**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -3; F=/home/shishi/dev/src/github.com/shishi/fantia-dl; mkdir -p src/offscreen public/offscreen && cp "$F"/src/offscreen/protocol.ts "$F"/src/offscreen/offscreen.ts src/offscreen/ && cp "$F"/public/offscreen/offscreen.html public/offscreen/'
```

Expected: zip.test FAIL、コピー成功

- [ ] **Step 3: zip.ts を実装**

`src/background/zip.ts`(骨子。offscreen 系関数は fantia-dl service-worker.ts の該当関数を移植し、`conflictAction` を `CONFLICT_ACTION` に、Port 受信をローカルループに置き換える):

```ts
import { zipSync } from "fflate";
import { bytesToBase64 } from "../core/base64";
import { renderTemplate } from "../core/template-engine";
import { validateMediaUrl } from "../core/url-allowlist";
import { CONFLICT_ACTION } from "../core/settings";
import { buildRenderContext, buildZipRenderContext } from "./render-adapter";
import { OFFSCREEN_TARGET } from "../offscreen/protocol";
import type { OffscreenChunkMessage, OffscreenDoneMessage, OffscreenRevokeMessage, OffscreenResult } from "../offscreen/protocol";
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
  files: Array<{ url: string; idemKey: string; size?: number }>, postId: string,
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
    buffers.set(f.idemKey, buf);
  }
  return { ok: true, buffers };
}

export function buildZip(
  post: PostData, block: ContentBlock, buffers: Map<string, Uint8Array>, s: Settings, now: Date,
): { zipPath: string; bytes: Uint8Array } {
  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  for (const f of block.files) {
    const buf = buffers.get(f.idemKey);
    // spec §7b: 黙った欠落の禁止。ソースが揃っていない zip は組み立てず error にして
    // 呼び出し側の個別 DL フォールバックに乗せる。
    if (!buf) throw new Error(`zip ソース欠落: ${f.idemKey}`);
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
    usedNames.add(entryPath);
    entries[entryPath] = buf;
  }
  const zipCtx = buildZipRenderContext(post, block, now);
  const zipPath = renderTemplate(s.zipPathTemplate, zipCtx, { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
  return { zipPath, bytes: zipSync(entries) };
}

// --- 以下、offscreen 経由の blob DL(fantia-dl service-worker.ts の zip 部分を移植) ---
// 移植時の必須追加(spec §7b 途中失敗の配達経路): handleZipDownloadChange が
// interrupted を観測したときは blob URL の revoke に加えて
// console.error(`[fanbox-dl] zip のダウンロードに失敗しました。${ZIP_RETRY_WORDING}`)
// を出す(blob DL 発行後は click 応答が返却済みで通知不能のため、Chrome の
// ダウンロード UI の失敗表示 + このログが明示エラーの配達経路になる。README にも明記)。
// テスト可能にするため handleZipDownloadChange / registerZipDownload は
// deps 注入(revoke / log / search / sessionStorage)を optional 引数で受ける設計にする。
// ensureOffscreenDocument / sendChunkToOffscreen / finishZipDownload / revokeOffscreenUrl /
// zipDownloads(storage.session 同期)/ reconcileZipDownloads は fantia-dl の同名実装を
// そのままここへ移す(実装者は $FANTIA/src/background/service-worker.ts の 76〜173 行と
// 「起動時 reconcile (zip DL)」ブロックを読んで移植する)。
// 変更点は 2 つだけ:
//  1. conflictAction 引数を廃し CONFLICT_ACTION 定数を使う
//  2. downloadZipViaOffscreen(zipPath, bytes) を新設: SW 内で bytes を 4MB チャンクに割り
//     bytesToBase64 -> sendChunkToOffscreen をループし、最後に finishZipDownload を呼ぶ
//     (Port 受信は存在しない。fanbox では zip 生成が SW 起点のため)

export async function downloadZipViaOffscreen(zipPath: string, bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
  await ensureOffscreenDocument();
  const jobId = crypto.randomUUID();
  for (let off = 0; off < bytes.byteLength; off += ZIP_CHUNK_BYTES) {
    await sendChunkToOffscreen(jobId, bytesToBase64(bytes.subarray(off, Math.min(off + ZIP_CHUNK_BYTES, bytes.byteLength))));
  }
  const res = await finishZipDownload(jobId, zipPath);
  return res.queued === 1 ? { ok: true } : { ok: false, error: res.error };
}
```

(移植部分は上記コメントの指示どおり fantia-dl から持ってくる。`handleZipDownloadChange(delta)` は fantia の onChanged 内 zip 分岐を関数化、`reconcileZipDownloads()` は起動時 reconcile ブロックを関数化)

- [ ] **Step 4: green + 型チェック + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: SW-driven zip pipeline with byte budget and offscreen blob download" -m "spec §7b: CORS 全拒否の downloads.fanbox.cc に対し zip ソース取得を SW fetch(allowlist+直列+累積バジェット)へ再設計。blob 化は fantia-dl の offscreen 機構を移植。"'
```

---

