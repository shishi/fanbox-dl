import { validatePostInfo } from "../fanbox/api";
import { parsePost, emptyPostNotice } from "../fanbox/parse";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { validateMediaUrl } from "../core/url-allowlist";
import { CONFLICT_ACTION } from "../core/settings";
import { buildRenderContext } from "./render-adapter";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, ZIP_FALLBACK_WORDING, ZIP_RETRY_WORDING } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";
import type { Settings } from "../core/types";

// spec §変更 A: post.info fetch は content script。SW は受領 json を検証して
// fire-and-forget で DL する。dedup/履歴/resume は持たない。
// リダイレクト検出だけ downloadId→postId の揮発 Map + onChanged で軽量維持(fail-closed)。
const REDIRECT_MAP_KEY = "redirectMap";

export interface OrchestratorDeps {
  downloads: {
    download(opts: chrome.downloads.DownloadOptions): Promise<number>;
    search(q: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
    erase(q: chrome.downloads.DownloadQuery): Promise<number[]>;
    removeFile(id: number): Promise<void>;
  };
  loadSettings: () => Promise<Settings>;
  zip: {
    eligible: typeof zipEligible;
    collect: typeof collectZipSources;
    build: typeof buildZip;
    downloadViaOffscreen: typeof downloadZipViaOffscreen;
  };
  now: () => number;
  session: {
    get(key: string): Promise<any>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  log: (msg: string) => void;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  // downloadId -> postId(リダイレクト再検証用の揮発データ。dedup には使わない)
  const redirect = new Map<number, string>();

  async function persistRedirect(): Promise<void> {
    await deps.session.set({ [REDIRECT_MAP_KEY]: Object.fromEntries(redirect) });
  }
  async function loadRedirectMap(): Promise<void> {
    const r = await deps.session.get(REDIRECT_MAP_KEY);
    const obj = (r?.[REDIRECT_MAP_KEY] as Record<string, string>) ?? {};
    for (const [id, postId] of Object.entries(obj)) redirect.set(Number(id), postId);
  }

  const mkValidatePath = (s: Settings) => (relPath: string): string | null => {
    const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
    return v.ok ? null : v.error;
  };

  async function startDownload(url: string, filename: string, postId: string): Promise<void> {
    // spec §4a: download 直前に allowlist 再検証(最後の砦)。
    const v = validateMediaUrl(url, postId);
    if (!v.ok) throw new Error(`allowlist 違反: ${v.error}`);
    const id = await deps.downloads.download({ url, filename, saveAs: false, conflictAction: CONFLICT_ACTION });
    redirect.set(id, postId);
    await persistRedirect();
  }

  async function handleDownloadRequest(msg: DownloadRequestMessage): Promise<DownloadResponse> {
    const res: DownloadResponse = { queued: 0, zipQueued: 0, notices: [], errors: [] };

    const schemaErr = validatePostInfo(msg.json, msg.postId);
    if (schemaErr) { res.errors.push(schemaErr); return res; }
    const post = parsePost(msg.json);
    if (post.restricted) { res.notices.push("アクセス権がないためダウンロードできません(未加入プランの投稿、または本文を取得できない投稿)"); return res; }
    if (post.skippedEmbeds > 0) res.notices.push(`埋め込みコンテンツ ${post.skippedEmbeds} 件は DL 対象外です`);
    if (post.contents.length === 0) {
      if (post.skippedEmbeds === 0) res.notices.push(emptyPostNotice(post.postType));
      return res;
    }

    const s = await deps.loadSettings();
    const now = new Date(deps.now());
    const vp = mkValidatePath(s);

    // allowlist(spec §4a: あらゆるネットワーク使用の前)
    for (const b of post.contents) {
      b.files = b.files.filter((f) => {
        const v = validateMediaUrl(f.url, post.postId);
        if (!v.ok) res.errors.push(v.error);
        return v.ok;
      });
    }

    for (const b of post.contents) {
      let zipDone = false;
      if (deps.zip.eligible(b, s)) {
        const collected = await deps.zip.collect(b.files.map((f) => ({ url: f.url, size: f.size })), post.postId, {});
        if (collected.ok) {
          try {
            const { zipPath, bytes } = deps.zip.build(post, b, collected.buffers, s, now);
            const pv = vp(zipPath);
            if (pv) throw new Error(`${zipPath}: ${pv}`);
            const dl = await deps.zip.downloadViaOffscreen(zipPath, bytes);
            if (dl.ok) { res.zipQueued++; zipDone = true; }
            else res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${dl.error}`);
          } catch (e) {
            res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${e instanceof TemplateError ? e.message : String(e)}`);
          }
        } else {
          res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${collected.error}`);
        }
      }
      if (zipDone) continue;
      for (const f of b.files) {
        if (!(s.contentTypes as any)[f.contentType]) continue;
        let relPath: string;
        try {
          relPath = renderTemplate(s.pathTemplate, buildRenderContext(post, b, f, now), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
        } catch (e) {
          res.errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
          return res; // テンプレ不正は全体中断
        }
        const pv = vp(relPath);
        if (pv) { res.errors.push(`${relPath}: ${pv}`); continue; }
        try { await startDownload(f.url, relPath, post.postId); res.queued++; }
        catch (e) { res.errors.push(String(e)); }
      }
    }
    return res;
  }

  async function handleDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    if (!delta.state || delta.id === undefined) return;
    const cur = delta.state.current;
    if (cur !== "complete" && cur !== "interrupted") return;
    const postId = redirect.get(delta.id);
    if (postId === undefined) return; // 自分の通常 DL ではない(zip は SW 側で先に処理)
    redirect.delete(delta.id);
    await persistRedirect();
    if (cur === "interrupted") return; // 失敗は fire-and-forget(検証不要)

    // spec §変更 A / §4a-3: 完了時に finalUrl を allowlist 再検証、fail-closed。
    const [item] = await deps.downloads.search({ id: delta.id });
    // fail-closed(spec §変更 A): finalUrl が無いとき url(要求 URL)で代用しない。
    const finalUrl = (item as any)?.finalUrl as string | undefined;
    if (!item || !finalUrl || !validateMediaUrl(finalUrl, postId).ok) {
      try { await deps.downloads.removeFile(delta.id); } catch {}
      try { await deps.downloads.erase({ id: delta.id }); } catch {}
      deps.log(`[fanbox-dl] 許可外 URL へリダイレクトされた可能性があるためダウンロードを破棄しました(postId ${postId})`); // spec §変更 A: click 応答返却後のため console が通知チャネル(zip と同じ制約)
    }
  }

  return { handleDownloadRequest, handleDownloadChanged, loadRedirectMap };
}
