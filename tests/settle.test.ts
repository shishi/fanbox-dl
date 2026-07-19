import { describe, it, expect } from "vitest";
import { settleInFlight } from "../src/background/settle";
import { JobStore } from "../src/background/job-store";
import { applyEnqueue, applyDownloadStarted } from "../src/background/ledger";

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
