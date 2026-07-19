import { describe, it, expect } from "vitest";
import { JobStore, StorageWriteError } from "../src/background/job-store";
import { emptyLedger, type Ledger } from "../src/background/ledger";

const memStorage = () => {
  const mem: Record<string, unknown> = {};
  return {
    mem,
    get: async (key: string) => ({ [key]: mem[key] }),
    set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
  };
};

describe("JobStore", () => {
  it("read は未初期化なら emptyLedger 形状を返す", async () => {
    const s = new JobStore(memStorage());
    expect(await s.read()).toEqual(emptyLedger());
  });
  it("commit は read->transform->set を行い result を返す", async () => {
    const st = memStorage();
    const s = new JobStore(st);
    const r = await s.commit((l) => ({ ledger: { ...l, generations: { k: 1 } }, result: "ok" }));
    expect(r).toBe("ok");
    expect((st.mem.jobs as Ledger).generations).toEqual({ k: 1 });
  });
  it("並行 commit が直列化される(lost update なし)", async () => {
    const s = new JobStore(memStorage());
    const bump = () => s.commit((l) => {
      const n = (l.generations.count ?? 0) + 1;
      return { ledger: { ...l, generations: { ...l.generations, count: n } }, result: n };
    });
    await Promise.all([bump(), bump(), bump()]);
    expect((await s.read()).generations.count).toBe(3);
  });
  it("必須レーステスト: ダブルクリック/2タブ/lease 未解決中の並行 enqueue で download が二重発行されない (spec §7c-2)", async () => {
    const { applyEnqueue } = await import("../src/background/ledger");
    const s = new JobStore(memStorage());
    let tok2 = 0;
    const enqueueOnce = () => s.commit((l) => {
      const r = applyEnqueue(l, [{
        idemKey: "1:image:a", postId: "1", stableContentId: "image:a", contentType: "photo",
        url: "https://downloads.fanbox.cc/images/post/1/a.jpg", basePath: "p/a.jpg",
        refetch: { postId: "1", stableContentId: "image:a", index: 0 },
      }], { force: false, postUpdatedAt: "x", now: 1, newLeaseToken: () => `LQ${++tok2}`, validatePath: () => null });
      return { ledger: r.ledger, result: r.toStart.length };
    });
    // ダブルクリック(並行 2 発)
    const [a, b] = await Promise.all([enqueueOnce(), enqueueOnce()]);
    expect(a + b).toBe(1);
    // 2 タブ相当(さらに並行 2 発)も追加発行しない
    const [c, d] = await Promise.all([enqueueOnce(), enqueueOnce()]);
    expect(c + d).toBe(0);
    // lease 解決が未完(pending のまま downloadId 無し)でも次の enqueue は発行しない
    expect(await enqueueOnce()).toBe(0);
  });

  it("set 失敗で StorageWriteError + failClosed (spec §7c-2 必須テスト)", async () => {
    const st = memStorage();
    st.set = async () => { throw new Error("QUOTA"); };
    const s = new JobStore(st);
    await expect(s.commit((l) => ({ ledger: l, result: 1 }))).rejects.toThrow(StorageWriteError);
    expect(s.failClosed).toBe(true);
  });
});
