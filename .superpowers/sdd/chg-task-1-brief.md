### Task 1: バックエンドの fire-and-forget 化

ledger 群を削除し、型・parse・zip・orchestrator・service-worker・messages を fire-and-forget に書き換える。**密結合のため 1 タスク**(ビルド緑を保つには一括更新が必要)。deliverable: `bun run test` 全 green + `bun run typecheck` 0 + `bun run build` 成功。

**Files:**
- Modify: `src/core/types.ts`, `src/fanbox/parse.ts`, `src/background/zip.ts`, `src/content/messages.ts`, `src/background/orchestrator.ts`(全面書き換え), `src/background/service-worker.ts`(全面書き換え)
- Delete: 上記「削除するファイル」7 モジュール + 8 テスト
- Test: `tests/parse.test.ts`(更新), `tests/zip.test.ts`(更新), `tests/orchestrator.test.ts`(全面書き換え)

**Interfaces:**
- Consumes: `validateMediaUrl`(url-allowlist)/ `renderTemplate`,`TemplateError`(template-engine)/ `validatePath`(path-validator)/ `buildRenderContext`,`buildZipRenderContext`(render-adapter)/ `validatePostInfo`(fanbox/api)/ `parsePost`,`emptyPostNotice`(parse)/ `zipEligible`,`collectZipSources`,`buildZip`,`downloadZipViaOffscreen`,`handleZipDownloadChange`,`reconcileZipDownloads`,`ZIP_FALLBACK_WORDING`,`ZIP_RETRY_WORDING`(zip)/ `loadSettings`,`CONFLICT_ACTION`(settings)
- Produces:
  - `FileItem`(identity フィールド撤去): `{ contentType, url, filename, ext, size?, seq, total }`
  - `PostData`(updatedAtIso 撤去): `{ postId, postTitle, creator, creatorId, fee, publishedAt, restricted, postType, skippedEmbeds, contents }`
  - `DownloadRequestMessage`: `{ kind:"download"; postId:string; json:unknown }`(force 撤去)
  - `collectZipSources(files: {url;size?}[], postId, deps?)`(buffers は **url をキー**)、`buildZip(...)`(buffers.get(f.url))
  - `createOrchestrator(deps): { handleDownloadRequest(msg); handleDownloadChanged(delta); loadRedirectMap() }`(startup reconcile は zip のみ、通常 DL は redirect map ロードだけ)

#### 規則(fire-and-forget フロー・spec §変更 A)
1. `handleDownloadRequest`: `validatePostInfo(msg.json, msg.postId)` → schema エラーは errors に積んで返す → `parsePost` → restricted なら「アクセス権なし」notice + return → `skippedEmbeds>0` なら embed notice → contents 空なら(skippedEmbeds===0 のときだけ)`emptyPostNotice(postType)` notice して return。
2. 各ブロック: メディア URL を `validateMediaUrl(url, postId)` で filter(違反は errors、download に渡さない)。`zipEligible` なら zip 試行(collect→build→downloadViaOffscreen)、失敗は `ZIP_FALLBACK_WORDING`+`ZIP_RETRY_WORDING` を notice して個別 DL にフォールバック。個別 DL は contentTypes フィルタ後、各ファイルで render→validatePath→`chrome.downloads.download({url,filename,saveAs:false,conflictAction:CONFLICT_ACTION})`。成功したら `downloadId→postId` を redirect map に記録(storage.session 同期)。テンプレエラーは errors。
3. `handleDownloadChanged`: redirect map に無い downloadId は無視(zip は service-worker が先に処理)。complete で map にある downloadId は finalUrl を allowlist 再検証、外れ/取得不能なら `removeFile`+`erase`+console 通知(fail-closed)。complete/interrupted いずれも map から除去(+persist)。
4. startup: `reconcileZipDownloads()`(zip・既存)+ `orchestrator.loadRedirectMap()`(storage.session から復元)。通常 DL の resume/needs_page は無い。

- [ ] **Step 1: 削除対象モジュールとテストを削除**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git rm src/background/ledger.ts src/background/job-store.ts src/background/mutation-queue.ts src/background/adoption.ts src/background/settle.ts src/background/failure-classifier.ts src/core/canonical-relpath.ts tests/ledger-enqueue.test.ts tests/ledger-lifecycle.test.ts tests/job-store.test.ts tests/mutation-queue.test.ts tests/adoption.test.ts tests/settle.test.ts tests/failure-classifier.test.ts tests/canonical-relpath.test.ts && echo deleted'
```

Expected: 15 ファイルが削除される(この時点でビルド/型は赤。Step 2〜7 で緑に戻す)。

- [ ] **Step 2: `src/core/types.ts` を更新(FileItem/PostData から identity・updatedAtIso 撤去)**

`FileItem` と `PostData` を次に置き換える(他の型 = ContentType/ContentBlock/RenderContext/Settings は現状維持):

```ts
export interface FileItem {
  contentType: ContentType;
  url: string;               // downloads.fanbox.cc の直 URL(zip の buffers キーにも使う=post 内で一意)
  filename: string | null;   // file: name(拡張子なし) / image: URL basename(ハッシュ)
  ext: string;               // 拡張子(ドットなし)
  size?: number;             // file item のみ(zip 事前サイズチェック用)
  seq: number;               // ブロック内 1-based(重複スキップ後)
  total: number;             // ブロック内総数(重複スキップ後)
}

export interface ContentBlock {
  blockOrdinal: number;      // post 内 1-based 通し番号($contentId の値。識別子ではない)
  contentType: ContentType;
  files: FileItem[];
}

export interface PostData {
  postId: string;
  postTitle: string;
  creator: string;
  creatorId: string;
  fee: number;
  publishedAt: Date;
  restricted: boolean;
  postType: string;
  skippedEmbeds: number;
  contents: ContentBlock[];
}
```

(`RenderContext` と `Settings` は変更しない。`idemKey`/`stableContentId`/`refetch`/`updatedAtIso` を参照するコードは Step 3〜7 で消える。)

- [ ] **Step 3: `src/fanbox/parse.ts` を更新(identity 生成と updatedAtIso を撤去、post 内重複スキップは維持)**

`imageToItem` / `fileToItem` / 末尾のブロック組み立てを次に置き換える(post 内の同一 image/file id 重複スキップ = `seen` ロジックは**維持**。同じファイルを 1 クリックで二重 DL しないため):

```ts
function imageToItem(im: RawImage): Omit<FileItem, "seq" | "total"> {
  return {
    contentType: "photo",
    url: im.originalUrl,
    filename: urlBasenameNoExt(im.originalUrl),
    ext: (im.extension || "").toLowerCase(),
  };
}

function fileToItem(f: RawFile): Omit<FileItem, "seq" | "total"> {
  const ext = (f.extension || "").toLowerCase();
  return {
    contentType: VIDEO_EXT.has(ext) ? "video" : "file",
    url: f.url,
    filename: f.name ?? null,
    ext,
    size: typeof f.size === "number" ? f.size : undefined,
  };
}
```

`parsePost` の PostData リテラルから `updatedAtIso: ...` 行を削除。末尾のブロック組み立てを次に置き換える(idemKey/refetch を作らない):

```ts
  let ordinal = 0;
  for (const g of groups) {
    ordinal++;
    const files: FileItem[] = g.items.map((it, i) => ({
      ...it,
      seq: i + 1,
      total: g.items.length,
    }));
    data.contents.push({
      blockOrdinal: ordinal,
      contentType: g.kind === "image" ? "photo" : "file",
      files,
    });
  }
  return data;
}
```

(`push`/`seen`/`groups` の重複スキップ・グルーピング・embed カウントは現状のまま維持。`parseIndex` 変数は削除。)

**さらに `tests/render-adapter.test.ts` を更新**: このテストは `PostData` リテラルに `updatedAtIso`、`FileItem` リテラルに `idemKey`/`stableContentId`/`refetch` を書いているため、Step 2 の型変更後に typecheck が落ちる。これらのフィールドを両リテラルから削除する(render-adapter の入出力アサーション本体 = contentId/plan/filename/seq/total 等は変更しない)。

- [ ] **Step 4: `tests/parse.test.ts` を更新(identity アサーション撤去)**

`stableContentId` / `idemKey` / `refetch` / `updatedAtIso` を参照する assertion を削除し、残す観点に置き換える。具体的には:
- 各 `expect(...stableContentId...)` / `expect(...idemKey...)` / `expect(...refetch...)` / `expect(p.updatedAtIso...)` の行を削除。
- image/file/article の各テストで「files の url・filename・ext・seq・total・contentType」と「contents の blockOrdinal・contentType」を検証する形にする。
- **重複スキップの必須テストは url ベースで残す**: 「同じ imageId が非連続に 2 回出現 → url が 1 つだけ(重複しない)」を `expect(all.map(f => f.url))` の一意性で検証。
- 「imageId と fileId が同値でも別扱い」テストは、image と file それぞれ 1 件ずつ url が出ることを検証(idemKey ではなく url/contentType で)。
- restricted(両条件)・text/未知(contents 空)・embed カウント(skippedEmbeds)・emptyPostNotice の各テストは維持。

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH; cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test tests/parse.test.ts 2>&1 | tail -8'`
Expected: parse.test.ts が green(実装 Step 3 と整合)。

- [ ] **Step 5: `src/background/zip.ts` の buffers キーを idemKey→url に変更**

`collectZipSources` の引数と buffers キー、`buildZip` の lookup を idemKey から url に変える(url は post 内で一意):

```ts
// collectZipSources の引数型
files: Array<{ url: string; size?: number }>, postId: string,
```
- 本体の `buffers.set(f.idemKey, buf)` を `buffers.set(f.url, buf)` に。
- `buildZip` 内 `const buf = buffers.get(f.idemKey);` を `const buf = buffers.get(f.url);` に(`f` は `block.files` の FileItem で `f.url` を持つ)。
- 呼び出し側(orchestrator)は `b.files.map((f) => ({ url: f.url, size: f.size }))` を渡す(Step 6)。
- `tests/zip.test.ts`: `collectZipSources` に渡す item と `buildZip` のフィクスチャの `idemKey` 参照を `url` ベースに更新(item は `{url, size}`、buildZip の buffers Map は `new Map([[block.files[0].url, ...]])`)。zipEligible / 事前サイズ / budget / 欠落 throw / エントリ名衝突 の各テストは維持。
  **さらに `redirect:"error"` のアサーションを新規追加**(現状の zip.test には無い): fetchFn の
  mock に渡された `init` を捕捉し、`collectZipSources` が `fetch(url, { credentials:"include", redirect:"error" })`
  で呼んでいることを検証する(例: `let seenInit; fetchFn = async (_u, init) => { seenInit = init; return chunked([1]).resp; }` として `expect(seenInit.redirect).toBe("error")`)。

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH; cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test tests/zip.test.ts 2>&1 | tail -8'`
Expected: zip.test.ts green。

- [ ] **Step 6: `src/content/messages.ts` と `src/background/orchestrator.ts` を書き換え**

`src/content/messages.ts` を次に置き換え(force と ClearHistoryMessage を撤去):

```ts
// content script -> SW のメッセージ。post.info の fetch は content script(isolated world)が行い(spec §4a)、
// その json を渡す。SW は受領 json を検証してから使う。
export interface DownloadRequestMessage {
  kind: "download";
  postId: string;
  json: unknown;
}

export interface DownloadResponse {
  queued: number;
  zipQueued: number;
  notices: string[];
  errors: string[];
}

// /posts/{id}(サブドメイン形式)と /@{slug}/posts/{id}(www 形式)の両対応
export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}
```

`src/background/orchestrator.ts` を全面的に次へ置き換える(fire-and-forget + 軽量 redirect map):

```ts
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
```

- [ ] **Step 7: `src/background/service-worker.ts` を書き換え(ledger/clearHistory 撤去)**

```ts
// service-worker.ts: 薄い束縛のみ。SW ロジック本体は orchestrator.ts。
import { loadSettings } from "../core/settings";
import { createOrchestrator } from "./orchestrator";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, handleZipDownloadChange, reconcileZipDownloads } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";

const orchestrator = createOrchestrator({
  downloads: {
    download: (opts) => chrome.downloads.download(opts),
    search: (q) => chrome.downloads.search(q),
    erase: (q) => chrome.downloads.erase(q),
    removeFile: (id) => chrome.downloads.removeFile(id),
  },
  loadSettings,
  zip: { eligible: zipEligible, collect: collectZipSources, build: buildZip, downloadViaOffscreen: downloadZipViaOffscreen },
  now: () => Date.now(),
  session: {
    get: (k) => chrome.storage.session.get(k),
    set: (items) => chrome.storage.session.set(items),
  },
  log: (m) => console.error(m),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "download") {
    orchestrator.handleDownloadRequest(msg as DownloadRequestMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ queued: 0, zipQueued: 0, notices: [], errors: [String(e)] } satisfies DownloadResponse));
    return true;
  }
  return false;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (await handleZipDownloadChange(delta)) return; // zip 由来
  await orchestrator.handleDownloadChanged(delta);
});

// 起動時: zip blob URL の revoke 用復元 + redirect map 復元(通常 DL の resume は無い)
(async () => {
  await reconcileZipDownloads();
  await orchestrator.loadRedirectMap();
})().catch((e) => console.error("[fanbox-dl] startup failed:", e));
```

- [ ] **Step 8: `tests/orchestrator.test.ts` を全面書き換え**

fire-and-forget フローの契約テスト。mock deps(downloads.download が id を返し記録、search/erase/removeFile、loadSettings=DEFAULT_SETTINGS、zip、now、session=in-memory、log=収集)で次を固定:
1. **個別 DL**: image 投稿(zipEligible=false にした設定 or file 投稿)で各ファイルが `download({conflictAction:"uniquify"})` される・queued 件数一致。
2. **zip フォールバック**: zipEligible=true だが collect が失敗 → 個別 DL に切替、`ZIP_FALLBACK_WORDING` と `ZIP_RETRY_WORDING` 両方を含む notice。
3. **allowlist 違反**: 違反 URL は download されず errors に出る。
4. **restricted / body:null**: 通知のみ・download ゼロ。
5. **finalUrl 再検証**: (a) finalUrl が allowlist 外 → removeFile+erase+log、(b) search が item を返さない → 同上(fail-closed)、(c) 正常 finalUrl → 何もしない。redirect map は complete/interrupted で除去される。

テストコード骨子(実装者は下記を具体化。mock は最小):

```ts
import { describe, it, expect } from "vitest";
import { createOrchestrator, type OrchestratorDeps } from "../src/background/orchestrator";
import { DEFAULT_SETTINGS } from "../src/core/settings";

const img = (id: string) => ({ id, extension: "jpeg", width: 1, height: 1, originalUrl: `https://downloads.fanbox.cc/images/post/1/${id}.jpeg`, thumbnailUrl: `https://downloads.fanbox.cc/images/post/1/t${id}.jpeg` });
const postJson = (images: any[], over: any = {}) => ({ body: { post: { id: "1", title: "T", feeRequired: 0, publishedDatetime: "2026-07-01T00:00:00+09:00", isRestricted: false, user: { userId: "9", name: "C" }, creatorId: "s", type: "image", body: { text: "", images }, ...over } } });

function mkDeps(over: Partial<OrchestratorDeps> = {}) {
  const downloaded: Array<{ url: string; filename: string; conflictAction?: string }> = [];
  const erased: number[] = []; const removed: number[] = []; const logs: string[] = [];
  const mem: Record<string, unknown> = {};
  let nextId = 100;
  let searchImpl: (q: any) => Promise<any[]> = async () => [];
  const deps: OrchestratorDeps = {
    downloads: {
      download: async (o) => { downloaded.push({ url: o.url!, filename: o.filename!, conflictAction: o.conflictAction }); return ++nextId; },
      search: (q) => searchImpl(q),
      erase: async (q) => { erased.push((q as any).id); return [(q as any).id]; },
      removeFile: async (id) => { removed.push(id); },
    },
    loadSettings: async () => ({ ...DEFAULT_SETTINGS }),
    zip: { eligible: () => false, collect: async () => ({ ok: false, error: "x" }), build: () => { throw new Error("x"); }, downloadViaOffscreen: async () => ({ ok: true }) },
    now: () => 1000,
    session: { get: async (k) => ({ [k]: mem[k] }), set: async (i) => { Object.assign(mem, i); } },
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, downloaded, erased, removed, logs, setSearch: (f: typeof searchImpl) => { searchImpl = f; } };
}

describe("orchestrator fire-and-forget", () => {
  it("個別 DL: 各ファイルを uniquify で download する", async () => {
    const { deps, downloaded } = mkDeps();
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a"), img("b")]) });
    expect(res.queued).toBe(2);
    expect(downloaded).toHaveLength(2);
    expect(downloaded.every((d) => d.conflictAction === "uniquify")).toBe(true);
  });

  it("zip フォールバックは 2 フレーズの notice + 個別 DL", async () => {
    const { deps, downloaded } = mkDeps({ zip: { eligible: () => true, collect: async () => ({ ok: false, error: "boom" }), build: () => { throw new Error("x"); }, downloadViaOffscreen: async () => ({ ok: true }) } });
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a"), img("b")]) });
    expect(downloaded).toHaveLength(2);
    expect(res.notices.some((n) => n.includes("zip にできないため個別ダウンロードに切り替えました"))).toBe(true);
    expect(res.notices.some((n) => n.includes("zip は最初からやり直し"))).toBe(true);
  });

  it("allowlist 違反 URL は download されず errors", async () => {
    const bad = { ...img("evil"), originalUrl: "https://evil.example.com/x.jpeg" };
    const { deps, downloaded } = mkDeps();
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([bad, img("ok")]) });
    expect(downloaded.map((d) => d.url)).toEqual([img("ok").originalUrl]);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it("restricted は通知のみ", async () => {
    const { deps, downloaded } = mkDeps();
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([], { isRestricted: true, body: null }) });
    expect(downloaded).toHaveLength(0);
    expect(res.notices.some((n) => n.includes("アクセス権"))).toBe(true);
  });

  it("finalUrl 再検証: allowlist 外 / item 無し は破棄+log、正常は何もしない", async () => {
    const { deps, removed, erased, logs, setSearch } = mkDeps();
    const o = createOrchestrator(deps);
    await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a")]) });
    // (a) allowlist 外へリダイレクト
    setSearch(async () => [{ id: 101, url: img("a").originalUrl, finalUrl: "https://evil.example.com/x.jpeg" } as any]);
    await o.handleDownloadChanged({ id: 101, state: { current: "complete", previous: "in_progress" } } as any);
    expect(removed).toContain(101); expect(erased).toContain(101);
    expect(logs.some((l) => l.includes("破棄"))).toBe(true);
    // (b) item 取得不能 → fail-closed
    const d2 = mkDeps(); const o2 = createOrchestrator(d2.deps);
    await o2.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a")]) });
    d2.setSearch(async () => []); // item 無し
    await o2.handleDownloadChanged({ id: 101, state: { current: "complete", previous: "in_progress" } } as any);
    expect(d2.removed).toContain(101); // fail-closed
    // (b2) item はあるが finalUrl が無い → fail-closed(url で代用しない)
    const d2b = mkDeps(); const o2b = createOrchestrator(d2b.deps);
    await o2b.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a")]) });
    d2b.setSearch(async () => [{ id: 101, url: img("a").originalUrl } as any]); // finalUrl 欠落
    await o2b.handleDownloadChanged({ id: 101, state: { current: "complete", previous: "in_progress" } } as any);
    expect(d2b.removed).toContain(101);
    // (c) 正常 finalUrl
    const d3 = mkDeps(); const o3 = createOrchestrator(d3.deps);
    await o3.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a")]) });
    d3.setSearch(async () => [{ id: 101, url: img("a").originalUrl, finalUrl: img("a").originalUrl } as any]);
    await o3.handleDownloadChanged({ id: 101, state: { current: "complete", previous: "in_progress" } } as any);
    expect(d3.removed).toHaveLength(0);
  });
});
```

- [ ] **Step 9: 全テスト + 型チェック + ビルド**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH; cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | grep -E "Test Files|Tests " && bun run typecheck 2>&1 | tail -1 && bun run build 2>&1 | tail -1'`
Expected: 全 green・型 0・build 成功。**core 4 ファイルと render-adapter/url-allowlist/api/offscreen が無変更**であることを `git diff --stat HEAD -- src/core/template-engine.ts src/core/sanitizer.ts src/core/path-validator.ts src/core/base64.ts` が空で確認。

- [ ] **Step 10: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "refactor: remove dedup/history machinery, make downloads fire-and-forget" -m "spec 2026-07-20 変更 A: ledger 群(ledger/job-store/mutation-queue/adoption/settle/failure-classifier/canonical-relpath)を削除し、SW は受領 json 検証→parse→allowlist→chrome.downloads.download(uniquify) の投げっぱなしに単純化。リダイレクト検出のみ downloadId→postId 揮発 Map + onChanged で軽量維持(finalUrl fail-closed)。zip・allowlist・通知は維持。"'
```

---

