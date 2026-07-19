### Task 11: job-store facade(TDD・spec §7c-2 書き込み契約)

**Files:**
- Create: `src/background/job-store.ts`
- Test: `tests/job-store.test.ts`

**Interfaces:**
- Consumes: `MutationQueue`(Task 8)、`Ledger / emptyLedger`(Task 9)
- Produces:

```ts
export class StorageWriteError extends Error {}
export class JobStore {
  constructor(storage?: { get(key: string): Promise<any>; set(items: Record<string, unknown>): Promise<void> }); // 省略時 chrome.storage.local
  failClosed: boolean; // set 失敗後 true。SW は enqueue/resume/force を拒否する(spec §7c-2)。
                       // メモリフラグのため、SW 起動時に必ず「無変換 commit」のプローブを行い
                       // 書き込み不能を再検出する(Task 15 の起動時 reconcile 冒頭)。復旧は clearHistory 成功時
  read(): Promise<Ledger>;
  commit<R>(transform: (l: Ledger) => { ledger: Ledger; result: R }): Promise<R>; // queue 経由 read->transform->1 set
}
```

- [ ] **Step 1: 失敗テストを書く**

`tests/job-store.test.ts`:

```ts
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
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL

- [ ] **Step 3: 実装**

`src/background/job-store.ts`:

```ts
import { MutationQueue } from "./mutation-queue";
import { emptyLedger, type Ledger } from "./ledger";

// spec §7c-2: 単一キー ledger の「読む -> 純粋変換 -> 1 回 set」を
// single-writer キュー経由で提供する唯一の書き込み口。
const KEY = "jobs";

export class StorageWriteError extends Error {}

interface StorageLike {
  get(key: string): Promise<any>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class JobStore {
  failClosed = false;
  private queue = new MutationQueue();
  private storage: StorageLike;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? {
      get: (k) => chrome.storage.local.get(k),
      set: (items) => chrome.storage.local.set(items),
    };
  }

  async read(): Promise<Ledger> {
    const raw = await this.storage.get(KEY);
    const l = raw?.[KEY] as Partial<Ledger> | undefined;
    return { jobs: l?.jobs ?? {}, generations: l?.generations ?? {} };
  }

  commit<R>(transform: (l: Ledger) => { ledger: Ledger; result: R }): Promise<R> {
    return this.queue.run(async () => {
      const current = await this.read();
      const { ledger, result } = transform(current);
      try {
        await this.storage.set({ [KEY]: ledger });
      } catch (e) {
        // spec §7c-2 書き込み失敗契約: 帳簿と実態がずれたまま走り続けない
        this.failClosed = true;
        throw new StorageWriteError(`ストレージ書き込みに失敗しました: ${String(e)}`);
      }
      return result;
    });
  }
}
```

- [ ] **Step 4: green + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: job-store facade with serialized atomic commits and fail-closed writes" -m "spec §7c-2: 全ミューテーションを single-writer キュー経由の 1 set に限定し、set 失敗は failClosed でDL 機能停止に倒す(帳簿乖離の走行継続を禁止)。"'
```

---

