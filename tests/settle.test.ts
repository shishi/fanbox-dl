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

  it("promise 喪失 + adoption が interrupted を見つけたら即分類してタイムアウトしない (spec §6/§7c-3 / 最終レビュー修正2)", async () => {
    const store = new JobStore(memStorage());
    await seedPending(store);
    const errors = await settleInFlight("111", {
      store, inFlight: new Map(),
      search: async (q: any) => {
        if (q?.id === 7) return [{ id: 7, filename: "/dl/fanbox/s/T/a.jpeg", error: "SERVER_FORBIDDEN", state: "interrupted" }];
        return [{ id: 7, url: "https://downloads.fanbox.cc/images/post/111/a.jpeg", filename: "/dl/fanbox/s/T/a.jpeg", startTime: new Date(2000).toISOString(), state: "interrupted" }];
      },
      cancel: async () => {}, now: (() => { let t = 0; return () => (t += 6000); })(), sleep: async () => {},
    });
    expect(errors).toEqual([]); // タイムアウトエラーにならない
    const l = await store.read();
    expect(l.jobs["111:image:a"].state).toBe("error"); // その場で確定
    expect(l.jobs["111:image:a"].error).toContain("未加入の有料コンテンツの可能性"); // SERVER_FORBIDDEN の明示文言
  });

  it("promise 喪失 + adoption が NETWORK_ interrupted(retry_once 相当)を見つけても pending のまま放置しない (codex レビュー指摘 P2)", async () => {
    const store = new JobStore(memStorage());
    await seedPending(store);
    const errors = await settleInFlight("111", {
      store, inFlight: new Map(),
      search: async (q: any) => {
        if (q?.id === 7) return [{ id: 7, filename: "/dl/fanbox/s/T/a.jpeg", error: "NETWORK_TIMEOUT", state: "interrupted" }];
        return [{ id: 7, url: "https://downloads.fanbox.cc/images/post/111/a.jpeg", filename: "/dl/fanbox/s/T/a.jpeg", startTime: new Date(2000).toISOString(), state: "interrupted" }];
      },
      cancel: async () => {}, now: (() => { let t = 0; return () => (t += 6000); })(), sleep: async () => {},
    });
    expect(errors).toEqual([]);
    const l = await store.read();
    // settle は force 前処理として非 terminal を残さない契約(spec §7c-3)。
    // retry_once の pending を放置して settleInFlight が「解決済み」と報告すると、
    // 誰も再ダウンロードを蹴らないまま force 後続処理を進めてしまう(wedge)。
    expect(l.jobs["111:image:a"].state).not.toBe("pending");
    expect(l.jobs["111:image:a"].state).toBe("error"); // terminal に倒して settle 完了とする
  });

  it("adoption が interrupted だが実体の再取得(id 指定)が空(race)なら reason を確定できないまま terminal 化しない (codex レビュー指摘 P2 round2)", async () => {
    const store = new JobStore(memStorage());
    await seedPending(store);
    const errors = await settleInFlight("111", {
      store, inFlight: new Map(),
      search: async (q: any) => {
        if (q?.id === 7) return []; // race: 実体を再取得できない(reason 不明)
        return [{ id: 7, url: "https://downloads.fanbox.cc/images/post/111/a.jpeg", filename: "/dl/fanbox/s/T/a.jpeg", startTime: new Date(2000).toISOString(), state: "interrupted" }];
      },
      cancel: async () => {}, now: (() => { let t = 0; return () => (t += 6000); })(), sleep: async () => {},
    });
    // reason(SERVER_FORBIDDEN 等)を確定できない以上、安易に一般的な terminal_error へ
    // 丸めて refusedUrl を失わせない。fail-closed でタイムアウト待機に落ちて
    // 明示エラーとして可視化される(force 後続処理を進めない)。
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("タイムアウト");
    const l = await store.read();
    expect(l.jobs["111:image:a"].refusedUrl).toBeUndefined();
  });
});
