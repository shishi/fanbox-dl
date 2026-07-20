import { describe, it, expect } from "vitest";
import { createOrchestrator, safeReplacement, type OrchestratorDeps } from "../src/background/orchestrator";
import { DEFAULT_SETTINGS } from "../src/core/settings";

const img = (id: string, postId = "1") => ({ id, extension: "jpeg", width: 1, height: 1, originalUrl: `https://downloads.fanbox.cc/images/post/${postId}/${id}.jpeg`, thumbnailUrl: `https://downloads.fanbox.cc/images/post/${postId}/t${id}.jpeg` });
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
  return { deps, downloaded, erased, removed, logs, mem, setSearch: (f: typeof searchImpl) => { searchImpl = f; } };
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

  it("body:null(isRestricted:false でも)は通知のみ・download ゼロ", async () => {
    const { deps, downloaded } = mkDeps();
    const o = createOrchestrator(deps);
    const res = await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([], { isRestricted: false, body: null }) });
    expect(downloaded).toHaveLength(0);
    expect(res.notices.some((n) => n.includes("アクセス権"))).toBe(true);
  });

  it("finalUrl 再検証: (a) allowlist 外 / (b) item 無し / (b2) finalUrl 欠落 は破棄+log、(c) 正常は何もしない", async () => {
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

  it("redirect map は complete/interrupted で除去される(未知 downloadId は無視)", async () => {
    const { deps, removed, setSearch } = mkDeps();
    const o = createOrchestrator(deps);
    await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a")]) });
    // 未知の downloadId は無視される(自分の通常 DL ではない)
    await o.handleDownloadChanged({ id: 9999, state: { current: "complete", previous: "in_progress" } } as any);
    expect(removed).toHaveLength(0);
    // interrupted は再検証せず単に map から除去される
    setSearch(async () => { throw new Error("should not be called"); });
    await expect(o.handleDownloadChanged({ id: 101, state: { current: "interrupted", previous: "in_progress" } } as any)).resolves.toBeUndefined();
  });

  it("並行 DL: 2 件がほぼ同時に開始しても session 保存の redirect map から片方が消えない(persist レース回避)", async () => {
    const mem: Record<string, unknown> = {};
    let calls = 0;
    const { deps } = mkDeps({
      session: {
        get: async (k) => ({ [k]: mem[k] }),
        set: async (items) => {
          const callIndex = calls++;
          // 最初の呼び出しほど長く待たせ、素朴な実装なら後発の書き込みが
          // 先に完了 → 古いスナップショットで上書き、というレースを誘発する。
          await new Promise((r) => setTimeout(r, callIndex === 0 ? 20 : 0));
          Object.assign(mem, items);
        },
      },
    });
    const o = createOrchestrator(deps);
    await Promise.all([
      o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a", "1")]) }),
      o.handleDownloadRequest({ kind: "download", postId: "2", json: postJson([img("b", "2")], { id: "2" }) }),
    ]);
    const saved = (mem["redirectMap"] ?? {}) as Record<string, string>;
    expect(Object.values(saved).sort()).toEqual(["1", "2"]);
  });

  it("SW 起動レース: loadRedirectMap を呼ぶ前に handleDownloadChanged が来ても、session の保存済みマップを読み込んでから finalUrl 検証する(fail-closed)", async () => {
    // 前インスタンスが persist した redirect map が既に session に残っている状況を模す。
    const mem: Record<string, unknown> = { redirectMap: { "101": "1" } };
    const { deps, removed, erased, setSearch } = mkDeps({
      session: {
        get: async (k) => ({ [k]: mem[k] }),
        set: async (items) => { Object.assign(mem, items); },
      },
    });
    setSearch(async () => [{ id: 101, url: "https://downloads.fanbox.cc/images/post/1/a.jpeg", finalUrl: "https://evil.example.com/x.jpeg" } as any]);
    const o = createOrchestrator(deps);
    // わざと loadRedirectMap() を呼ばない(SW 再起動直後、ロード未完了を模倣)。
    await o.handleDownloadChanged({ id: 101, state: { current: "complete", previous: "in_progress" } } as any);
    expect(removed).toContain(101);
    expect(erased).toContain(101);
  });

  it("codex-review 指摘(2 巡目): redirect-map 再読み込みが持続的に失敗(内部リトライも尽きる)しても (a) 当セッション中に in-memory 登録済みの DL は fail-closed 検証を続行し、(b) 失敗をキャッシュせず障害解消後の呼び出しで再読み込みを試みる", async () => {
    const mem: Record<string, unknown> = {};
    let failLoads = true;
    const { deps, removed, setSearch } = mkDeps({
      session: {
        get: async (k) => {
          if (failLoads) throw new Error("session.get 一時的失敗(持続)");
          return { [k]: mem[k] };
        },
        set: async (items) => { Object.assign(mem, items); },
      },
    });
    const o = createOrchestrator(deps);

    // (a) 当セッション中に登録済みの DL(id=101)は、ensureLoaded() が(内部リトライも
    //     含め)失敗しても in-memory map から postId を引けるため、fail-closed 検証まで届く。
    await o.handleDownloadRequest({ kind: "download", postId: "1", json: postJson([img("a")]) });
    setSearch(async () => [{ id: 101, url: img("a").originalUrl, finalUrl: "https://evil.example.com/x.jpeg" } as any]);
    await o.handleDownloadChanged({ id: 101, state: { current: "complete", previous: "in_progress" } } as any);
    expect(removed).toContain(101);

    // (b) 失敗をキャッシュしていない → 障害が解消した後の呼び出しでは session.get が
    //     成功し、別インスタンスが persist した(このセッションの in-memory には無い)
    //     downloadId=102 の redirect map エントリも正しく読み込まれる。
    failLoads = false;
    mem["redirectMap"] = { "102": "9" };
    setSearch(async () => [{ id: 102, url: "https://downloads.fanbox.cc/images/post/9/z.jpeg", finalUrl: "https://evil.example.com/z.jpeg" } as any]);
    await o.handleDownloadChanged({ id: 102, state: { current: "complete", previous: "in_progress" } } as any);
    expect(removed).toContain(102);
  });

  it("codex-review 指摘(3 巡目): session.get が数回連続で一時的に失敗しても短い遅延を挟んだリトライで復旧し、SW 再起動後に persist 済み(in-memory には無い)downloadId の fail-closed 検証を取りこぼさない", async () => {
    const mem: Record<string, unknown> = { redirectMap: { "101": "1" } };
    let getCalls = 0;
    const { deps, removed, setSearch } = mkDeps({
      session: {
        get: async (k) => {
          getCalls++;
          if (getCalls <= 2) throw new Error("session.get 一時的失敗");
          return { [k]: mem[k] };
        },
        set: async (items) => { Object.assign(mem, items); },
      },
    });
    setSearch(async () => [{ id: 101, url: "https://downloads.fanbox.cc/images/post/1/a.jpeg", finalUrl: "https://evil.example.com/x.jpeg" } as any]);
    const o = createOrchestrator(deps);
    // loadRedirectMap() を呼ばず、いきなり onChanged が来た(SW 起動レース)を模倣。
    await o.handleDownloadChanged({ id: 101, state: { current: "complete", previous: "in_progress" } } as any);
    expect(getCalls).toBeGreaterThanOrEqual(3);
    expect(removed).toContain(101);
  });
});

describe("safeReplacement(最終レビュー修正 P2: 保存済み illegalCharReplacement の実行時中和)", () => {
  it("'/' を含む場合は '_' に置き換える", () => { expect(safeReplacement("/")).toBe("_"); });
  it("'\\\\' を含む場合は '_' に置き換える", () => { expect(safeReplacement("\\")).toBe("_"); });
  it("空文字は '_' に置き換える", () => { expect(safeReplacement("")).toBe("_"); });
  it("正常な置換文字はそのまま返す", () => { expect(safeReplacement("_")).toBe("_"); expect(safeReplacement("-")).toBe("-"); });
});
