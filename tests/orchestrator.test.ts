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
});
