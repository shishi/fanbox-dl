import { describe, it, expect } from "vitest";
import { MutationQueue } from "../src/background/mutation-queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MutationQueue", () => {
  it("投入順に直列実行される(後発が先発を追い越さない)", async () => {
    const q = new MutationQueue();
    const order: number[] = [];
    const p1 = q.run(async () => { await sleep(30); order.push(1); });
    const p2 = q.run(async () => { order.push(2); });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
  it("run は fn の戻り値を返す", async () => {
    const q = new MutationQueue();
    expect(await q.run(async () => 42)).toBe(42);
  });
  it("前の fn が reject しても後続は実行される", async () => {
    const q = new MutationQueue();
    const p1 = q.run(async () => { throw new Error("boom"); });
    const p2 = q.run(async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    expect(await p2).toBe("ok");
  });
});
