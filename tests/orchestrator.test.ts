import { describe, it, expect } from "vitest";
import { createOrchestrator, type OrchestratorDeps } from "../src/background/orchestrator";
import { JobStore } from "../src/background/job-store";
import { applyEnqueue } from "../src/background/ledger";
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

  it("起動時 reconcile: crash-window adoption が complete でも finalUrl が allowlist 外なら done にせず error にする (spec §4a-3 / 最終レビュー修正1)", async () => {
    const { deps, store } = mkDeps();
    const url = "https://downloads.fanbox.cc/images/post/1/a.jpeg";
    const relPath = "fanbox/s/T/a.jpeg";
    await store.commit((l) => {
      const r = applyEnqueue(l, [{
        idemKey: "1:image:a", postId: "1", stableContentId: "image:a", contentType: "photo",
        url, basePath: relPath,
        refetch: { postId: "1", stableContentId: "image:a", index: 0 },
      }], { force: false, postUpdatedAt: "x", now: 1000, newLeaseToken: () => "L1", validatePath: () => null });
      return { ledger: r.ledger, result: null };
    });
    // adoption 検索(url 指定)ではヒットを返し、後段の実体再取得(id 指定)では
    // finalUrl が allowlist 外(redirect された想定)を返す。
    deps.downloads.search = async (q: any) => {
      if (q?.id === 55) return [{ id: 55, url, finalUrl: "https://evil.example.com/a.jpeg", filename: `/dl/${relPath}`, state: "complete" } as any];
      return [{ id: 55, url, filename: `/dl/${relPath}`, startTime: new Date(2000).toISOString(), state: "complete" }];
    };
    const o = createOrchestrator(deps);
    await o.runStartupReconcile();
    const rec = (await store.read()).jobs["1:image:a"];
    expect(rec.state).toBe("error"); // done にしない
    expect(rec.error).toContain("許可外");
  });

  it("起動時 reconcile: requested の実 DL が complete でも finalUrl が allowlist 外なら done にせず error にする (spec §4a-3 / 最終レビュー修正1)", async () => {
    const { deps, store } = mkDeps();
    const o = createOrchestrator(deps);
    await o.handleDownloadRequest({ kind: "download", postId: "1", force: false, json: postJson([img("a")]) });
    const rec0 = Object.values((await store.read()).jobs)[0];
    deps.downloads.search = async (q: any) => {
      if (q?.id === rec0.downloadId) return [{ id: rec0.downloadId, finalUrl: "https://evil.example.com/a.jpeg", filename: "/dl/x", state: "complete" } as any];
      return [];
    };
    await o.runStartupReconcile();
    const after = (await store.read()).jobs[rec0.idemKey];
    expect(after.state).toBe("error"); // done にしない
    expect(after.error).toContain("許可外");
  });

  it("起動時 reconcile: crash-window adoption 後の実体再取得が空(race)なら finalUrl 未検証のまま done にせず fail-closed で error にする (codex レビュー指摘 P3 round2)", async () => {
    const { deps, store } = mkDeps();
    const url = "https://downloads.fanbox.cc/images/post/1/a.jpeg";
    const relPath = "fanbox/s/T/a.jpeg";
    await store.commit((l) => {
      const r = applyEnqueue(l, [{
        idemKey: "1:image:a", postId: "1", stableContentId: "image:a", contentType: "photo",
        url, basePath: relPath,
        refetch: { postId: "1", stableContentId: "image:a", index: 0 },
      }], { force: false, postUpdatedAt: "x", now: 1000, newLeaseToken: () => "L1", validatePath: () => null });
      return { ledger: r.ledger, result: null };
    });
    // adoption 検索(url 指定)ではヒットを返すが、後段の実体再取得(id 指定)は
    // history clear 等のレースで空配列を返す想定。ここで hit.url(常に allowlist 内)を
    // 「検証済み finalUrl」として採用すると、redirect bypass を再び許してしまう。
    deps.downloads.search = async (q: any) => {
      if (q?.id === 55) return [];
      return [{ id: 55, url, filename: `/dl/${relPath}`, startTime: new Date(2000).toISOString(), state: "complete" } as any];
    };
    const o = createOrchestrator(deps);
    await o.runStartupReconcile();
    const rec = (await store.read()).jobs["1:image:a"];
    expect(rec.state).toBe("error"); // 検証できないまま done にしない(fail-closed)
  });

  it("onChanged: complete だが search({id}) が空(履歴クリア等のレース)なら done にせず error にする(finalUrl 未確認) (最終レビュー修正2 Fix A)", async () => {
    const { deps, store } = mkDeps({ zip: { eligible: () => false, collect: async () => ({ ok: false, error: "x" }), build: () => { throw new Error("x"); }, downloadViaOffscreen: async () => ({ ok: true }) } });
    const o = createOrchestrator(deps);
    await o.handleDownloadRequest({ kind: "download", postId: "1", force: false, json: postJson([img("a")]) });
    const rec = Object.values((await store.read()).jobs)[0];
    // rec.url にフォールバックすると常に allowlist を通ってしまい「確認できていないのに done」に
    // なる — item(finalUrl の出所)が取れない以上、done にせず fail-closed で error 化する。
    deps.downloads.search = async () => [];
    await o.handleDownloadChanged({ id: rec.downloadId!, state: { current: "complete", previous: "in_progress" } } as any);
    const after = (await store.read()).jobs[rec.idemKey];
    expect(after.state).toBe("error"); // done にしない
    expect(after.error).toContain("finalUrl");
  });

  it("起動時 reconcile: crash-window adoption した interrupted の hit が error(SERVER_FORBIDDEN) を持つ場合、実体再取得(id 指定)が空でも reason を失わず refusedUrl が付く (最終レビュー修正2 Fix C)", async () => {
    const { deps, store } = mkDeps();
    const url = "https://downloads.fanbox.cc/images/post/1/a.jpeg";
    const relPath = "fanbox/s/T/a.jpeg";
    await store.commit((l) => {
      const r = applyEnqueue(l, [{
        idemKey: "1:image:a", postId: "1", stableContentId: "image:a", contentType: "photo",
        url, basePath: relPath,
        refetch: { postId: "1", stableContentId: "image:a", index: 0 },
      }], { force: false, postUpdatedAt: "x", now: 1000, newLeaseToken: () => "L1", validatePath: () => null });
      return { ledger: r.ledger, result: null };
    });
    // adoption 検索(url 指定)ではヒットが SERVER_FORBIDDEN の error を持つ interrupted を返し、
    // 後段の実体再取得(id 指定)は history clear 等のレースで空を返す。
    deps.downloads.search = async (q: any) => {
      if (q?.id === 55) return [];
      return [{ id: 55, url, filename: `/dl/${relPath}`, startTime: new Date(2000).toISOString(), state: "interrupted", error: "SERVER_FORBIDDEN" } as any];
    };
    const o = createOrchestrator(deps);
    await o.runStartupReconcile();
    const rec = (await store.read()).jobs["1:image:a"];
    expect(rec.state).toBe("error");
    // reason が "interrupted" に丸められて SERVER_FORBIDDEN を喪失していないこと
    expect(rec.error).toContain("未加入の有料コンテンツの可能性");
    expect(rec.refusedUrl).toBe(url);
  });
});
