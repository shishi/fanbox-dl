import { MutationQueue } from "./mutation-queue";
import { type Ledger } from "./ledger";

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
