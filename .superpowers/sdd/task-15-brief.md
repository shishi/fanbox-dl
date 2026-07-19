### Task 15: service-worker 配線 + manifest + build 完成

**Files:**
- Create: `src/background/orchestrator.ts`(SW ロジック本体。**deps 注入ファクトリ**でテスト可能に)
- Modify: `src/background/service-worker.ts`(Task 2 の gate 版を全面置き換え。orchestrator への薄い束縛のみ)
- Create: `src/background/settle.ts`(force 前処理。deps 注入でテスト可能に)
- Test: `tests/settle.test.ts`, `tests/orchestrator.test.ts`
- Modify: `public/manifest.json`(完成版)
- Modify: `scripts/build.mjs`(fantia-dl 原本から page-script entry だけ除いた 4 entry に戻す)

**orchestrator 構造(normative)**: Step 3 のコードに現れるロジック
(`handleDownloadRequest` / `startDownload` / onChanged 処理 / 起動時 reconcile)は
`src/background/orchestrator.ts` の `createOrchestrator(deps)` の**中に**実装する:

```ts
export interface OrchestratorDeps {
  store: JobStore;
  downloads: {
    download(opts: chrome.downloads.DownloadOptions): Promise<number>;
    search(q: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
    cancel(id: number): Promise<void>;
  };
  loadSettings: () => Promise<Settings>;
  // 注: post.info fetch は content script が担うため fetchPost dep は無い(spec §4a)。
  //     handleDownloadRequest は message で渡された json を検証して使う。
  zip: {
    eligible: typeof zipEligible;
    collect: typeof collectZipSources;
    build: typeof buildZip;
    downloadViaOffscreen: typeof downloadZipViaOffscreen;
  };
  now: () => number;
  newLeaseToken: () => string;
}
export function createOrchestrator(deps: OrchestratorDeps): {
  handleDownloadRequest(msg: DownloadRequestMessage): Promise<DownloadResponse>;
  handleDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void>;
  runStartupReconcile(): Promise<void>;
}
```

Step 3 のコード中の `chrome.downloads.*` は `deps.downloads.*`、
`loadSettings` は `deps.loadSettings`、zip 関数群は `deps.zip.*`、
`Date.now()` は `deps.now()` に読み替える。`service-worker.ts` は実 deps で
createOrchestrator を呼び、`chrome.runtime.onMessage` / `chrome.downloads.onChanged` /
起動時 reconcile に束縛するだけの薄いファイルにする(zip の onChanged 分岐
`handleZipDownloadChange` と `reconcileZipDownloads` の呼び出しも service-worker.ts 側)。

**Interfaces:**
- Consumes: これまでの全モジュール
- Produces: 動く拡張(options 以外)

- [ ] **Step 1: manifest / build.mjs を完成させる**

`public/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "fanbox-dl",
  "version": "0.1.0",
  "description": "pixivFANBOX の投稿をテンプレート命名で自動ダウンロード(個人アーカイブ用)",
  "permissions": ["downloads", "storage", "offscreen"],
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "host_permissions": ["https://*.fanbox.cc/*"],
  "content_scripts": [
    { "matches": ["https://*.fanbox.cc/*"], "js": ["content/content-script.js"], "run_at": "document_idle" }
  ],
  "web_accessible_resources": [],
  "options_page": "options/options.html",
  "action": { "default_title": "fanbox-dl" },
  "icons": {}
}
```

`scripts/build.mjs` の entries を以下に(page-script は存在しない):

```js
const entries = [
  { in: "src/content/content-script.ts",    out: "dist/content/content-script.js",    format: "iife" },
  { in: "src/background/service-worker.ts", out: "dist/background/service-worker.js", format: "esm" },
  { in: "src/options/options.ts",           out: "dist/options/options.js",           format: "esm" },
  { in: "src/offscreen/offscreen.ts",       out: "dist/offscreen/offscreen.js",       format: "iife" },
];
```

- [ ] **Step 2: settle.ts(force 前処理)を TDD で書く**

spec §7c-3 の必須テスト「lease 窓中の force」をユニットで検証できるよう、依存を注入する。

`tests/settle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { settleInFlight } from "../src/background/settle";
import { JobStore } from "../src/background/job-store";
import { emptyLedger, applyEnqueue, applyDownloadStarted } from "../src/background/ledger";

const memStorage = () => {
  const mem: Record<string, unknown> = {};
  return { get: async (k: string) => ({ [k]: mem[k] }), set: async (i: Record<string, unknown>) => { Object.assign(mem, i); } };
};
let tok = 0;
const seedPending = async (store: JobStore) => {
  let leaseToken = "";
  await store.commit((l) => {
    const r = applyEnqueue(l, [{
      idemKey: "111:image:a", postId: "111", stableContentId: "image:a", contentType: "photo",
      url: "https://downloads.fanbox.cc/images/post/111/a.jpeg", basePath: "fanbox/s/T/a.jpeg",
      refetch: { postId: "111", stableContentId: "image:a", index: 0 },
    }], { force: false, postUpdatedAt: "x", now: 1000, newLeaseToken: () => `L${++tok}`, validatePath: () => null });
    leaseToken = r.toStart[0].leaseToken!;
    return { ledger: r.ledger, result: null };
  });
  return leaseToken;
};

describe("settleInFlight (spec §7c-3 lease 窓中の force)", () => {
  it("promise が追跡できる場合はその解決を待つ", async () => {
    const store = new JobStore(memStorage());
    const token = await seedPending(store);
    let resolved = false;
    const inFlight = new Map([[token, (async () => { resolved = true; })()]]);
    const errors = await settleInFlight("111", { store, inFlight, search: async () => [], cancel: async () => {}, now: () => 5000, sleep: async () => {} });
    expect(resolved).toBe(true);
    expect(errors).toEqual([]);
  });
  it("promise 喪失 + adoption が terminal を見つけたら採用(complete)してから進む", async () => {
    const store = new JobStore(memStorage());
    await seedPending(store);
    const errors = await settleInFlight("111", {
      store, inFlight: new Map(),
      search: async () => [{ id: 7, url: "https://downloads.fanbox.cc/images/post/111/a.jpeg", filename: "/dl/fanbox/s/T/a.jpeg", startTime: new Date(2000).toISOString(), state: "complete" }],
      cancel: async () => {}, now: () => 5000, sleep: async () => {},
    });
    expect(errors).toEqual([]);
    const l = await store.read();
    expect(l.jobs["111:image:a"].state).toBe("done"); // 採用された
  });
  it("promise 喪失 + adoption ヒットなしなら lease を CAS 解決(error)して進む(未解決 requeue の禁止)", async () => {
    const store = new JobStore(memStorage());
    await seedPending(store);
    const errors = await settleInFlight("111", { store, inFlight: new Map(), search: async () => [], cancel: async () => {}, now: () => 5000, sleep: async () => {} });
    expect(errors).toEqual([]);
    const l = await store.read();
    expect(l.jobs["111:image:a"].state).toBe("error"); // 未解決のまま放置しない
  });
  it("force が lease 解決待ちの間も onChanged の更新が通る(デッドロックしない) (spec §7c-2 必須テスト)", async () => {
    const store = new JobStore(memStorage());
    const token = await seedPending(store);
    await store.commit((l) => ({ ledger: applyDownloadStarted(l, "111:image:a", token, 9), result: null }));
    // settle の待機ループ中に「onChanged 相当」の ledger 更新(cancel の terminal 到達)を
    // sleep フック経由で流し込む。single-writer キューが待機で塞がっていれば
    // この commit は完了できずテストはタイムアウトする(= デッドロック検出)。
    let injected = false;
    const deps = {
      store, inFlight: new Map<string, Promise<void>>(),
      search: async () => [], cancel: async () => {},
      now: () => 5000,
      sleep: async () => {
        if (!injected) {
          injected = true;
          const { applyDownloadInterrupted: adi } = await import("../src/background/ledger");
          await store.commit((l) => ({ ledger: adi(l, "111:image:a", token, "terminal_error", "USER_CANCELED", () => "LX", 6000), result: null }));
        }
      },
    };
    const errors = await settleInFlight("111", deps);
    expect(errors).toEqual([]); // onChanged 相当が通って terminal を観測できた
    expect((await store.read()).jobs["111:image:a"].state).toBe("error");
  });

  it("downloadId 持ちの進行中は cancel し、terminal 遷移をタイムアウト付きで待つ", async () => {
    const store = new JobStore(memStorage());
    const token = await seedPending(store);
    await store.commit((l) => ({ ledger: applyDownloadStarted(l, "111:image:a", token, 9), result: null }));
    let cancelled = 0;
    // onChanged 相当が来ない -> タイムアウトエラー
    const errors = await settleInFlight("111", { store, inFlight: new Map(), search: async () => [], cancel: async () => { cancelled++; }, now: (() => { let t = 0; return () => (t += 6000); })(), sleep: async () => {} });
    expect(cancelled).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("タイムアウト");
  });
});
```

失敗を確認してから `src/background/settle.ts` を実装:

```ts
import { findAdoptable } from "./adoption";
import { applyDownloadStarted, applyDownloadComplete, applyDownloadRequestFailed } from "./ledger";
import type { JobStore } from "./job-store";

export interface SettleDeps {
  store: JobStore;
  inFlight: Map<string, Promise<void>>; // leaseToken -> 進行中の download() 呼び出し
  search: (q: { url?: string; id?: number }) => Promise<Array<{ id: number; url?: string; filename: string; startTime?: string; state?: string }>>;
  cancel: (id: number) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

// spec §7c-3: force の前処理。対象投稿の非 terminal ジョブをすべて「解決済み」にする。
// lease 未解決(downloadId 未永続)のままの requeue は禁止 — promise 待ち、または
// adoption 検索(terminal は採用・進行中は cancel・ヒットなしは CAS で error 化)で必ず決着させる。
export async function settleInFlight(postId: string, deps: SettleDeps): Promise<string[]> {
  const errors: string[] = [];
  const snapshot = await deps.store.read();
  for (const rec of Object.values(snapshot.jobs)) {
    if (rec.postId !== postId) continue;
    if (rec.state !== "pending" && rec.state !== "requested") continue;
    const token = rec.leaseToken;
    if (!token) continue;

    if (rec.downloadId === undefined) {
      const p = deps.inFlight.get(token);
      if (p) {
        await p; // (a) 生きた promise はその解決を待つ
      } else {
        // (b) promise 喪失: adoption 述語で browser 側の実体を探す
        const items = await deps.search({ url: rec.url });
        const hit = findAdoptable(
          items.map((d) => ({ id: d.id, url: d.url ?? "", filename: d.filename, startTime: d.startTime ?? "", state: d.state })),
          { url: rec.url, relPath: rec.relPath, leasedAt: rec.leasedAt ?? 0 },
        );
        if (hit && hit.state === "complete") {
          // terminal は採用してから進む(成果を捨てない)
          await deps.store.commit((l) => ({ ledger: applyDownloadComplete(applyDownloadStarted(l, rec.idemKey, token, hit.id), rec.idemKey, token, hit.filename, deps.now()), result: null }));
          continue;
        }
        if (hit) {
          await deps.store.commit((l) => ({ ledger: applyDownloadStarted(l, rec.idemKey, token, hit.id), result: null }));
          try { await deps.cancel(hit.id); } catch {}
        } else {
          // browser 側に実体なし = download() は発火しなかった。CAS で決着させる
          await deps.store.commit((l) => ({ ledger: applyDownloadRequestFailed(l, rec.idemKey, token, "lease 未解決(ダウンロード実体なし)"), result: null }));
          continue;
        }
      }
    }

    // downloadId が付いた進行中を cancel -> terminal 遷移の有界待機(onChanged が ledger を進める)
    const cur1 = (await deps.store.read()).jobs[rec.idemKey];
    if (cur1 && (cur1.state === "pending" || cur1.state === "requested") && cur1.downloadId !== undefined) {
      try { await deps.cancel(cur1.downloadId); } catch {}
      const deadline = deps.now() + 10_000;
      for (;;) {
        const cur = (await deps.store.read()).jobs[rec.idemKey];
        if (!cur || cur.state === "done" || cur.state === "error" || cur.state === "needs_page") break;
        if (deps.now() >= deadline) { errors.push(`${rec.relPath}: 進行中ダウンロードの停止がタイムアウトしました`); break; }
        await deps.sleep(200);
      }
    }
  }
  return errors;
}
```

green を確認してから次へ。

- [ ] **Step 3: service-worker.ts を書く**

`src/background/service-worker.ts`(全面置き換え):

```ts
import { loadSettings, CONFLICT_ACTION } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { validateMediaUrl } from "../core/url-allowlist";
import { parsePost, emptyPostNotice } from "../fanbox/parse";
import { validatePostInfo } from "../fanbox/api";
import { buildRenderContext } from "./render-adapter";
import { classifyDownloadError } from "./failure-classifier";
import { findAdoptable } from "./adoption";
import {
  applyEnqueue, applyDownloadStarted, applyDownloadRequestFailed, applyDownloadComplete,
  applyDownloadInterrupted, applyNeedsPageRecovery, applyClearTerminal, applyPruneSweep,
  findLeasesWithoutDownloadId, applyReissueLease, applyInvalidateByIds,
  type EnqueueCandidate, type JobRecord,
} from "./ledger";
import { JobStore, StorageWriteError } from "./job-store";
import { settleInFlight } from "./settle";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, handleZipDownloadChange, reconcileZipDownloads, ZIP_FALLBACK_WORDING, ZIP_RETRY_WORDING } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";
import type { PostData, Settings } from "../core/types";

const store = new JobStore();
// force の lease 解決待ち用: leaseToken -> 進行中の download() 呼び出し(spec §7c-3(a))
const inFlightDownloads = new Map<string, Promise<void>>();

const newLeaseToken = () => crypto.randomUUID();
const mkValidatePath = (s: Settings) => (relPath: string): string | null => {
  const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
  return v.ok ? null : v.error;
};

// download() はキューの外で呼ぶ(spec §7c-2 デッドロック防止)。結果反映は短いキュー項目。
function startDownload(rec: JobRecord): Promise<void> {
  const token = rec.leaseToken!;
  const p = (async () => {
    // spec §4a: allowlist はあらゆるネットワーク使用の直前に必ず通す。
    // retry / resume / reissue は永続化済み URL を使うため、ここでの再検証が最後の砦。
    const v = validateMediaUrl(rec.url, rec.postId);
    if (!v.ok) {
      await store.commit((l) => ({ ledger: applyDownloadRequestFailed(l, rec.idemKey, token, `allowlist 違反: ${v.error}`, Date.now()), result: null }));
      inFlightDownloads.delete(token);
      return;
    }
    try {
      const downloadId = await chrome.downloads.download({
        url: rec.url, filename: rec.relPath, saveAs: false, conflictAction: CONFLICT_ACTION,
      });
      await store.commit((l) => ({ ledger: applyDownloadStarted(l, rec.idemKey, token, downloadId), result: null }));
    } catch (e) {
      await store.commit((l) => ({ ledger: applyDownloadRequestFailed(l, rec.idemKey, token, String(e)), result: null }));
    } finally {
      inFlightDownloads.delete(token);
    }
  })();
  inFlightDownloads.set(token, p);
  return p;
}

// force 前処理は settle.ts(spec §7c-3。ユニットテスト済み)を使う
const settleDeps = {
  store, inFlight: inFlightDownloads,
  search: (q: { url?: string; id?: number }) => chrome.downloads.search(q),
  cancel: (id: number) => chrome.downloads.cancel(id),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

async function handleDownloadRequest(msg: DownloadRequestMessage): Promise<DownloadResponse> {
  const res: DownloadResponse = { queued: 0, zipQueued: 0, notices: [], errors: [] };
  if (store.failClosed) {
    res.errors.push("ストレージ書き込みに失敗しました。履歴をクリアするまで DL 機能を停止します");
    return res;
  }

  // spec §4a: post.info は content script が isolated world で fetch 済み。
  // SW は受領 json を検証してから使う(生データを信用しない)。
  const schemaErr = validatePostInfo(msg.json, msg.postId);
  if (schemaErr) { res.errors.push(schemaErr); return res; }

  const post = parsePost(msg.json);
  if (post.restricted) { res.notices.push("アクセス権がないためダウンロードできません(未加入プランの投稿、または本文を取得できない投稿)"); return res; }
  // spec §2「対象外・通知のみ」: embed 通知を先に出し、embed だけの投稿は
  // 汎用「DL 対象なし」を重ねない(通知のみの扱い)
  if (post.skippedEmbeds > 0) {
    res.notices.push(`埋め込みコンテンツ ${post.skippedEmbeds} 件は DL 対象外です`);
  }
  if (post.contents.length === 0) {
    if (post.skippedEmbeds === 0) res.notices.push(emptyPostNotice(post.postType));
    return res;
  }

  const s = await loadSettings();
  const now = new Date();
  const vp = mkValidatePath(s);

  // 前回までの明示エラーをクリック時に可視化する(静かな失敗の禁止。spec §7a)
  {
    const cur = await store.read();
    const prevErrors = Object.values(cur.jobs).filter((j) => j.postId === post.postId && j.state === "error");
    if (prevErrors.length > 0) {
      res.notices.push(`前回までに ${prevErrors.length} 件が失敗しています: ${prevErrors.slice(0, 3).map((j) => j.error).join(" / ")}`);
    }
  }

  // 全メディア URL の allowlist(spec §4a: あらゆるネットワーク使用の前)
  const invalidIds = new Set<string>();
  for (const b of post.contents) {
    b.files = b.files.filter((f) => {
      const v = validateMediaUrl(f.url, post.postId);
      if (!v.ok) { res.errors.push(v.error); invalidIds.add(f.stableContentId); }
      return v.ok;
    });
  }

  // spec §7c-3: force はまず対象投稿の非 terminal ジョブをすべて決着させる
  // (needs_page 回復や enqueue で新しい非 terminal を作る前に行う — 順序は normative)
  if (msg.force) {
    const errs = await settleInFlight(post.postId, settleDeps);
    res.errors.push(...errs);
    if (errs.length) return res; // lease 未解決のままの requeue は禁止(spec §7c-3)
  }

  // spec §4a: allowlist 違反 ID の既存ジョブ(進行中/needs_page)を error 化し、
  // 進行中だったものは実 DL も cancel する
  if (invalidIds.size > 0) {
    const before = await store.read();
    const toCancel = Object.values(before.jobs)
      .filter((j) => j.postId === post.postId && invalidIds.has(j.stableContentId) && j.downloadId !== undefined && (j.state === "pending" || j.state === "requested"))
      .map((j) => j.downloadId!) ;
    const inv = await store.commit((l) => {
      const r = applyInvalidateByIds(l, post.postId, invalidIds, Date.now());
      return { ledger: r.ledger, result: r.invalidated };
    });
    for (const id of toCancel) { try { await chrome.downloads.cancel(id); } catch {} }
    for (const k of inv) res.errors.push(`${k}: メディア URL が許可外のためダウンロードできません`);
  }

  // needs_page 回復(spec §6): この投稿の needs_page レコードを安定 ID で再バインド
  const fresh = post.contents.flatMap((b) => b.files.map((f) => ({
    stableContentId: f.stableContentId, url: f.url,
    basePath: renderTemplate(s.pathTemplate, buildRenderContext(post, b, f, now), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen }),
  })));
  try {
    const rec = await store.commit((l) => {
      const r = applyNeedsPageRecovery(l, post.postId, fresh, { now: Date.now(), postUpdatedAt: post.updatedAtIso, newLeaseToken, validatePath: vp, invalidIds });
      return { ledger: r.ledger, result: r };
    });
    for (const j of rec.toStart) { void startDownload(j); res.queued++; }
    for (const k of rec.missing) res.errors.push(`${k}: 投稿が編集され該当ファイルは存在しません`);
    for (const k of rec.refused) res.errors.push(`${k}: 同じ URL のままサーバ側の失敗が続いています。時間を置いて再試行してください`);
    for (const k of rec.invalid) res.errors.push(`${k}: メディア URL が許可外のためダウンロードできません`);
    res.errors.push(...rec.errors);
  } catch (e) {
    if (e instanceof StorageWriteError) { res.errors.push(e.message); return res; }
    throw e;
  }

  // ブロックごとに zip か個別かを決め、candidates を組み立てる
  const candidates: EnqueueCandidate[] = [];
  for (const b of post.contents) {
    let zipDone = false;
    if (zipEligible(b, s)) {
      const collected = await collectZipSources(b.files.map((f) => ({ url: f.url, idemKey: f.idemKey, size: f.size })), post.postId, {});
      if (collected.ok) {
        try {
          const { zipPath, bytes } = buildZip(post, b, collected.buffers, s, now);
          const pv = vp(zipPath);
          if (pv) throw new Error(`${zipPath}: ${pv}`);
          const dl = await downloadZipViaOffscreen(zipPath, bytes);
          if (dl.ok) { res.zipQueued++; zipDone = true; }
          else res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${dl.error}`);
        } catch (e) {
          res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${e instanceof TemplateError ? e.message : String(e)}`);
        }
      } else {
        res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${collected.error}`);
      }
    }
    if (zipDone) continue; // spec §7b: zip 成立ブロックは個別 enqueue しない
    for (const f of b.files) {
      if (!(s.contentTypes as any)[f.contentType]) continue;
      let basePath: string;
      try {
        basePath = renderTemplate(s.pathTemplate, buildRenderContext(post, b, f, now), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
      } catch (e) {
        res.errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
        return res; // テンプレ不正は全体中断(fantia-dl と同じ契約)
      }
      candidates.push({
        idemKey: f.idemKey, postId: post.postId, stableContentId: f.stableContentId,
        contentType: f.contentType, url: f.url, basePath, refetch: f.refetch,
      });
    }
  }

  try {
    const r = await store.commit((l) => {
      const out = applyEnqueue(l, candidates, {
        force: msg.force, postUpdatedAt: post.updatedAtIso, now: Date.now(),
        newLeaseToken, validatePath: vp,
      });
      return { ledger: out.ledger, result: out };
    });
    res.errors.push(...r.errors);
    for (const k of r.inFlightBlocked) res.notices.push(`${k}: 進行中のダウンロードがあります。作り直すには再DLボタンを`);
    for (const k of r.staleWarnings) res.notices.push(`${k}: 投稿は更新されていますが、このファイルの URL は変わっていません。差し替えを確実に取り込むには 🔄(再DL)を使ってください`);
    for (const j of r.toStart) { void startDownload(j); res.queued++; }
  } catch (e) {
    if (e instanceof StorageWriteError) { res.errors.push(e.message); return res; }
    throw e;
  }
  return res;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "download") {
    handleDownloadRequest(msg as DownloadRequestMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ queued: 0, zipQueued: 0, notices: [], errors: [String(e)] } satisfies DownloadResponse));
    return true;
  }
  if (msg?.kind === "clearHistory") {
    store.commit((l) => ({ ledger: applyClearTerminal(l), result: null }))
      .then(() => { store.failClosed = false; sendResponse({ ok: true }); })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (await handleZipDownloadChange(delta)) return; // zip 由来(job-store 対象外)
  if (!delta.state) return;
  const cur = delta.state.current;
  if (cur !== "complete" && cur !== "interrupted") return;

  const ledger = await store.read();
  const rec = Object.values(ledger.jobs).find((j) => j.downloadId === delta.id);
  if (!rec || !rec.leaseToken) return;
  const token = rec.leaseToken;

  if (cur === "complete") {
    // spec §7c-2: 実保存パスを取得して乖離を判定
    const [item] = await chrome.downloads.search({ id: delta.id });
    // spec §4a-3(緩和): 最終 URL が allowlist を抜けていたら done にせず error 化(redirect 対策)
    const finalUrl = (item as any)?.finalUrl || item?.url || rec.url;
    if (!validateMediaUrl(finalUrl, rec.postId).ok) {
      await store.commit((l) => ({ ledger: applyDownloadInterrupted(l, rec.idemKey, token, "terminal_error", "ダウンロードが許可外 URL にリダイレクトされました", newLeaseToken, Date.now()), result: null }));
      return;
    }
    await store.commit((l) => ({ ledger: applyDownloadComplete(l, rec.idemKey, token, item?.filename ?? "", Date.now()), result: null }));
    return;
  }
  const [item] = await chrome.downloads.search({ id: delta.id });
  // classify と ledger 記録は同一の解決済み reason を使う(SERVER_FORBIDDEN の明示文言と
  // refusedUrl 刻印が、reason の取得元の違いで欠けないように)
  const reason = delta.error?.current ?? item?.error ?? "interrupted";
  const action = classifyDownloadError(reason === "interrupted" ? undefined : reason);
  const after = await store.commit((l) => {
    const l2 = applyDownloadInterrupted(l, rec.idemKey, token, action, reason, newLeaseToken, Date.now());
    return { ledger: l2, result: l2.jobs[rec.idemKey] };
  });
  if (after && after.state === "pending") void startDownload(after); // NETWORK_ の有界リトライ
});

// 起動時 reconcile(spec §7c-1 / fantia-dl 同等)
(async () => {
  // spec §7c-2 フェイルクローズの再起動耐性: failClosed はメモリフラグなので、
  // 起動のたびに「現 ledger をそのまま書き戻す」プローブ commit で書き込み可否を再検出する。
  // 失敗したら failClosed が立ち(JobStore.commit 内)、resume を含む DL 機能を停止する。
  try {
    await store.commit((l) => ({ ledger: l, result: null }));
  } catch {
    console.error("[fanbox-dl] storage write probe failed — DL 機能を停止します(履歴クリアで復旧)");
    return; // reconcile も行わない(帳簿を進められないため)
  }
  await reconcileZipDownloads();
  const ledger = await store.read();

  // lease 済み・downloadId 未永続(crash window): adoption 述語で引き取り、ダメなら再投入
  for (const rec of findLeasesWithoutDownloadId(ledger)) {
    const items = await chrome.downloads.search({ url: rec.url });
    const hit = findAdoptable(
      items.map((d) => ({ id: d.id, url: d.url ?? "", filename: d.filename, startTime: d.startTime ?? "", state: d.state })),
      { url: rec.url, relPath: rec.relPath, leasedAt: rec.leasedAt ?? 0 },
    );
    if (hit) {
      await store.commit((l) => ({ ledger: applyDownloadStarted(l, rec.idemKey, rec.leaseToken!, hit.id), result: null }));
      if (hit.state === "complete") {
        await store.commit((l) => ({ ledger: applyDownloadComplete(l, rec.idemKey, rec.leaseToken!, hit.filename, Date.now()), result: null }));
      } else if (hit.state === "interrupted") {
        // 採用した実体が既に interrupted の場合、ここで分類まで済ませないと
        // 「requested のまま enqueue をブロックし続ける」wedge になる
        const [d] = await chrome.downloads.search({ id: hit.id });
        const reason = d?.error ?? "interrupted";
        const action = classifyDownloadError(reason === "interrupted" ? undefined : reason);
        const after = await store.commit((l) => {
          const l2 = applyDownloadInterrupted(l, rec.idemKey, rec.leaseToken!, action, reason, newLeaseToken, Date.now());
          return { ledger: l2, result: l2.jobs[rec.idemKey] };
        });
        if (after && after.state === "pending") void startDownload(after);
      }
      // in_progress は onChanged の terminal 到達に任せる
    } else {
      // spec §7c-2: requeue は lease を再発行してから(旧 lease の遅延解決を CAS で殺すため)
      const reissued = await store.commit((l) => {
        const r = applyReissueLease(l, rec.idemKey, rec.leaseToken!, newLeaseToken(), Date.now());
        return { ledger: r.ledger, result: r.record };
      });
      if (reissued) void startDownload(reissued); // 最悪ケースは uniquify の重複 1 個(spec §7c-1)
    }
  }

  // requested: downloadId の実状態と突き合わせ
  // (crash-window ループが ledger を進めた可能性があるため必ず再読込する — stale snapshot 禁止)
  const ledger2 = await store.read();
  for (const rec of Object.values(ledger2.jobs)) {
    if (rec.state !== "requested" || rec.downloadId === undefined || !rec.leaseToken) continue;
    const [d] = await chrome.downloads.search({ id: rec.downloadId });
    if (!d) {
      const reissued = await store.commit((l) => {
        const r = applyReissueLease(l, rec.idemKey, rec.leaseToken!, newLeaseToken(), Date.now());
        return { ledger: r.ledger, result: r.record };
      });
      if (reissued) void startDownload(reissued);
      continue;
    }
    if (d.state === "complete") {
      await store.commit((l) => ({ ledger: applyDownloadComplete(l, rec.idemKey, rec.leaseToken!, d.filename, Date.now()), result: null }));
    } else if (d.state === "interrupted") {
      const reason = d.error ?? "interrupted";
      const action = classifyDownloadError(reason === "interrupted" ? undefined : reason);
      const after = await store.commit((l) => {
        const l2 = applyDownloadInterrupted(l, rec.idemKey, rec.leaseToken!, action, reason, newLeaseToken, Date.now());
        return { ledger: l2, result: l2.jobs[rec.idemKey] };
      });
      if (after && after.state === "pending") void startDownload(after);
    }
  }

  // prune / sweep(spec §7c-2)
  await store.commit((l) => ({ ledger: applyPruneSweep(l, Date.now()), result: null }));
})().catch((e) => console.error("[fanbox-dl] reconcile failed:", e));
```

- [ ] **Step 4: orchestrator 統合テストを書く(spec の SW 層契約の固定)**

`tests/orchestrator.test.ts`(mock deps で 3 契約を固定):

```ts
import { describe, it, expect } from "vitest";
import { createOrchestrator, type OrchestratorDeps } from "../src/background/orchestrator";
import { JobStore } from "../src/background/job-store";
import { DEFAULT_SETTINGS } from "../src/core/settings";

const memStorage = () => {
  const mem: Record<string, unknown> = {};
  return { get: async (k: string) => ({ [k]: mem[k] }), set: async (i: Record<string, unknown>) => { Object.assign(mem, i); } };
};
const img = (id: string) => ({
  id, extension: "jpeg", width: 1, height: 1,
  originalUrl: `https://downloads.fanbox.cc/images/post/1/${id}.jpeg`,
  thumbnailUrl: `https://downloads.fanbox.cc/images/post/1/t${id}.jpeg`,
});
const postJson = (images: any[]) => ({ body: { post: {
  id: "1", title: "T", feeRequired: 0, publishedDatetime: "2026-07-01T00:00:00+09:00",
  updatedDatetime: "2026-07-02T00:00:00+09:00", isRestricted: false,
  user: { userId: "9", name: "C" }, creatorId: "s", type: "image",
  body: { text: "", images },
} } });

function mkDeps(over: Partial<OrchestratorDeps> = {}): { deps: OrchestratorDeps; downloaded: string[]; store: JobStore } {
  const store = new JobStore(memStorage()); // 各テストが ledger を直接検証できるよう露出する
  const downloaded: string[] = [];
  let nextId = 100;
  const deps: OrchestratorDeps = {
    store,
    downloads: {
      download: async (o) => { downloaded.push(o.url!); return ++nextId; },
      search: async () => [],
      cancel: async () => {},
    },
    loadSettings: async () => ({ ...DEFAULT_SETTINGS }),
    zip: {
      eligible: () => true,
      collect: async () => ({ ok: false, error: "fetch 失敗(テスト)" }),
      build: () => { throw new Error("unreachable"); },
      downloadViaOffscreen: async () => ({ ok: true }),
    },
    now: () => 1_000,
    newLeaseToken: (() => { let n = 0; return () => `T${++n}`; })(),
    ...over,
  };
  return { deps, downloaded, store };
}

describe("orchestrator (SW 層の spec 契約)", () => {
  it("zip 不成立ブロックは自動で個別 DL に enqueue され、必須文言の通知が付く (spec §7b)", async () => {
    const { deps, downloaded, store } = mkDeps();
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", force: false, json: postJson([img("a"), img("b")]) });
    expect(res.zipQueued).toBe(0);
    expect(res.queued).toBe(2); // フォールバックで 2 枚とも個別 enqueue
    expect(downloaded).toHaveLength(2);
    // spec §7b の 2 フレーズを両方含む
    expect(res.notices.some((n) => n.includes("zip にできないため個別ダウンロードに切り替えました"))).toBe(true);
    expect(res.notices.some((n) => n.includes("zip は最初からやり直し。確実性が要るなら通常 DL を。"))).toBe(true);
    // 一発 DL ではなくジョブ永続化ありの通常経路であること(spec §7a: ledger に requested で載る)
    const l = await store.read();
    const recs = Object.values(l.jobs).filter((j) => j.postId === "1");
    expect(recs.map((j) => j.stableContentId).sort()).toEqual(["image:a", "image:b"]);
    expect(recs.every((j) => j.state === "requested" && j.downloadId !== undefined)).toBe(true);
  });

  it("body:null(isRestricted:false)は『アクセス権なし』通知のみで enqueue に到達しない (spec §6)", async () => {
    const nullBody = { body: { post: { id: "1", title: "T", feeRequired: 500, publishedDatetime: "2026-07-01T00:00:00+09:00", updatedDatetime: "x", isRestricted: false, user: { userId: "9", name: "C" }, creatorId: "s", type: "image", body: null } } };
    const { deps, downloaded } = mkDeps();
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", force: false, json: nullBody });
    expect(res.queued).toBe(0);
    expect(res.errors).toEqual([]);
    expect(res.notices.some((n) => n.includes("アクセス権"))).toBe(true);
    expect(downloaded).toEqual([]);
    expect(Object.keys((await deps.store.read()).jobs)).toEqual([]); // enqueue 到達なし
  });

  it("allowlist 違反 URL は一切 download() されず、明示エラーになる (spec §4a: ネットワーク使用前)", async () => {
    const bad = { ...img("evil"), originalUrl: "https://evil.example.com/images/post/1/evil.jpeg" };
    const { deps, downloaded } = mkDeps({ zip: { eligible: () => false, collect: async () => ({ ok: false, error: "x" }), build: () => { throw new Error("x"); }, downloadViaOffscreen: async () => ({ ok: true }) } });
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", force: false, json: postJson([bad, img("ok")]) });
    expect(downloaded).toEqual([img("ok").originalUrl]); // 違反 URL は 1 バイトもネットワークに乗らない
    expect(res.errors.some((e) => e.includes("許可外"))).toBe(true);
    // spec §4a「ジョブを enqueue せず」: 違反 item の ledger レコードは作られない
    const keys = Object.keys((await deps.store.read()).jobs);
    expect(keys).toEqual(["1:image:ok"]);
  });

  it("onChanged: search 側だけが SERVER_FORBIDDEN を持つ interrupted でも必須文言 + refusedUrl が刻まれる (spec §6/§7a)", async () => {
    const { deps, downloaded, store } = mkDeps({ zip: { eligible: () => false, collect: async () => ({ ok: false, error: "x" }), build: () => { throw new Error("x"); }, downloadViaOffscreen: async () => ({ ok: true }) } });
    const o = createOrchestrator(deps);
    await o.handleDownloadRequest({ kind: "download", postId: "1", force: false, json: postJson([img("a"), img("b")]) });
    const rec = Object.values((await store.read()).jobs)[0];
    deps.downloads.search = async () => [{ id: rec.downloadId!, error: "SERVER_FORBIDDEN", state: "interrupted" } as any];
    await o.handleDownloadChanged({ id: rec.downloadId!, state: { current: "interrupted", previous: "in_progress" } } as any);
    const after = (await store.read()).jobs[rec.idemKey];
    expect(after.state).toBe("error");
    expect(after.error).toContain("未加入の有料コンテンツの可能性");
    expect(after.refusedUrl).toBe(after.url);
    expect(downloaded.length).toBeGreaterThan(0);
  });
});
```

失敗を確認 → orchestrator を実装(Step 3 のコードをファクトリ内へ)→ green。

- [ ] **Step 5: ビルド + 全テスト + 型チェック**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && bun run build && ls dist/background dist/content dist/offscreen'
```

Expected: テスト全 PASS・型エラー 0・4 bundle 生成(options はまだ無いので build が落ちる場合は Task 16 の options 完了後に再実行する旨を報告し、entries から一時的に options を除いた状態で green を確認)

- [ ] **Step 6: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "feat: wire service worker with canonical fetch, durable ledger and zip fallback" -m "spec §4a/§6/§7a-7c/§11 の配線: SW canonical post.info、allowlist 前置、needs_page 回復、lease/CAS/classifier 付き download ライフサイクル、force の lease 解決待ち、zip 不成立の個別 DL フォールバック、起動時 adoption/reconcile/prune。"'
```

---

