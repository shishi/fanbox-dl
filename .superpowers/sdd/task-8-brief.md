### Task 8: single-writer mutation queue(TDD・spec §7c-2)

**Files:**
- Create: `src/background/mutation-queue.ts`
- Test: `tests/mutation-queue.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `class MutationQueue { run<T>(fn: () => Promise<T>): Promise<T> }` — 投入順に直列実行。前の fn が reject してもチェーンは止まらない

- [ ] **Step 1: 失敗テストを書く**

`tests/mutation-queue.test.ts`:

```ts
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
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL

- [ ] **Step 3: 実装**

`src/background/mutation-queue.ts`:

```ts
// spec §7c-2: ledger への read-modify-write を直列化する single-writer キュー。
// キュー項目は短命な storage 操作のみを含めること(download() 等の待機を入れると
// 解消側の更新が同じキューの後ろに詰まりデッドロックする)。その規律は呼び出し側
// (job-store / service-worker)の契約であり、このクラスは純粋な直列化だけを提供する。
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn); // 前段の失敗でチェーンを止めない
    this.tail = next.catch(() => {});
    return next;
  }
}
```

- [ ] **Step 4: green + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: single-writer mutation queue" -m "spec §7c-2: enqueue/onChanged/force/prune/clear の read-modify-write 並行実行による last-write-wins 破壊を構造的に禁止する。"'
```

---

