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
