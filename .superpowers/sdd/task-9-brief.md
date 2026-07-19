### Task 9: ledger 変換 A — 型・enqueue・dedup・世代交代(TDD・spec §7c-2 / §8)

**Files:**
- Create: `src/background/ledger.ts`
- Test: `tests/ledger-enqueue.test.ts`

**Interfaces:**
- Consumes: `canonicalRelPath`(Task 6)
- Produces(Task 10/11/14 が使う):

```ts
export type JobState = "pending" | "requested" | "done" | "error" | "needs_page";
export interface JobRecord {
  idemKey: string;
  postId: string;
  stableContentId: string;
  contentType: string;
  relPath: string;              // canonical(canonicalRelPath 適用済み)
  url: string;
  generation: number;           // 初世代 0、世代交代で +1(spec §7c-2)
  state: JobState;
  leaseToken?: string;          // 非 terminal に必須
  leasedAt?: number;
  downloadId?: number;
  error?: string;
  doneAt?: number;
  terminalAt?: number;                  // すべての terminal 遷移(done/error/needs_page)で記録。sweep/cap の順序に使う
  refusedUrl?: string;                  // 回復拒否済み URL(同一 URL の自動再投入を禁止。spec §7a 明示エラー)
  actualFilename?: string;
  pathDivergent?: boolean;
  supersededUrl?: string;
  supersededAt?: number;
  pendingPostUpdatedAt?: string;        // enqueue 時点の post.updatedDatetime
  lastDownloadedPostUpdatedAt?: string; // 実 DL 完了時のみ更新(spec §8)
  lastWarnedPostUpdatedAt?: string;     // 警告 dedup 専用(spec §8)
  retriedNetwork?: boolean;
  refetch: { postId: string; stableContentId: string; index: number };
}
export interface Ledger {
  jobs: Record<string, JobRecord>;
  generations: Record<string, number>;  // tombstone: idemKey -> maxGeneration(spec §7c-2)
}
export function emptyLedger(): Ledger;

export interface EnqueueCandidate {
  idemKey: string; postId: string; stableContentId: string; contentType: string;
  url: string; basePath: string;   // テンプレ結果(canonical 化前)
  refetch: { postId: string; stableContentId: string; index: number };
}
export interface EnqueueResult {
  ledger: Ledger;
  toStart: JobRecord[];        // download() すべき新規レコード
  skippedDedup: string[];      // idemKey(dedup 成立でスキップ)
  inFlightBlocked: string[];   // idemKey(進行中により拒否・通知対象)
  staleWarnings: string[];     // idemKey(updatedDatetime 警告対象)
  errors: string[];            // パス検証エラー等
}
export function applyEnqueue(
  ledger: Ledger,
  candidates: EnqueueCandidate[],
  opts: {
    force: boolean;
    postUpdatedAt: string;                    // 今回 post.info の updatedDatetime
    now: number;
    newLeaseToken: () => string;
    validatePath: (relPath: string) => string | null; // エラー文字列 or null
  },
): EnqueueResult;
```

**applyEnqueue の規則(spec の対応箇所を必ず満たすこと)**:
0. **同一ミューテーション内 prune**(spec §7c-2): applyEnqueue は返却前に自身の結果 ledger を
   `applyPruneSweep(ledger, opts.now)`(Task 10)に通す。「上限超過状態の ledger を書かない」
   ため、挿入と prune は同じ変換(= 同じ 1 回の set)の中で完結する。**terminal レコードを
   作るすべての遷移**(`applyDownloadComplete` / `applyDownloadRequestFailed` /
   `applyDownloadInterrupted` の terminal 分岐 / `applyNeedsPageRecovery`)も同様に
   prune を通す。実装順の都合で Task 9 の時点では
   applyPruneSweep が未実装のため、**Task 10 完了時にこのパイプを両関数へ追加し、
   以下のテストも Task 10 で足す**:
   `applyEnqueue`/`applyDownloadComplete` の結果 ledger は terminal 件数が上限以下である
   (上限 +1 件の done がある状態から新 enqueue / complete しても超過 ledger にならない)。
1. **dedup 成立**(spec §8): 既存レコードが `state==="done"` かつ `pathDivergent !== true` かつ `record.url === cand.url` かつ `record.relPath === canonicalRelPath(cand.basePath, record.generation)` → skippedDedup。ただし `postUpdatedAt > record.lastDownloadedPostUpdatedAt` なら staleWarnings に積み、`lastWarnedPostUpdatedAt` を postUpdatedAt に更新(同値なら警告を再送しない。`lastDownloadedPostUpdatedAt` は絶対に進めない)
2. **再入規則**(spec §7c-2): 既存が pending/requested で `{url, relPath(canonical 比較)}` 一致 → 何もしない(inFlightBlocked ではなく skippedDedup 扱いでもなく、単に無視して二重 download() を防ぐ。返り値では skippedDedup に入れる)。不一致 → inFlightBlocked(自動置換禁止・通知)。force のときだけ世代交代スワップ
3. **世代交代スワップ**(stale-miss = done だが url or relPath 不一致 or pathDivergent、または force): `generation = 旧generation + 1`(レコードが無ければ `tombstone ?? 0`、tombstone があれば `tombstone + 1`)。`relPath = canonicalRelPath(basePath, newGen)`。**さらに新 relPath が旧レコードの relPath と同一なら generation をもう +1 して再導出**(同一パス世代交代の uniquify 逃げ禁止。通常は .revN が入るので同一にならないが、旧 relPath 自体が .revN 済みのケースを吸収)。旧 `url`/`doneAt` を `supersededUrl`/`supersededAt` へ。新レコードは pending + 新 leaseToken + leasedAt=now + pendingPostUpdatedAt=postUpdatedAt。`lastDownloadedPostUpdatedAt`/`lastWarnedPostUpdatedAt` は引き継ぐ
4. **新規**(レコード無し): generation = `tombstone ?? 0`、relPath = canonicalRelPath(basePath, gen)、pending + lease
5. **パス検証**: 最終 canonical relPath に `opts.validatePath` を適用。エラーなら errors に積みレコードは作らない。バッチ内 relPath 重複も errors
6. すべての遷移は入力 ledger を **破壊せず**新しい Ledger を返す(構造共有可)

- [ ] **Step 1: 失敗テストを書く**

`tests/ledger-enqueue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emptyLedger, applyEnqueue, type EnqueueCandidate, type Ledger } from "../src/background/ledger";

let tok = 0;
const opts = (over: Partial<Parameters<typeof applyEnqueue>[2]> = {}) => ({
  force: false, postUpdatedAt: "2026-07-02T00:00:00+09:00", now: 10_000,
  newLeaseToken: () => `L${++tok}`, validatePath: () => null, ...over,
});
const cand = (over: Partial<EnqueueCandidate> = {}): EnqueueCandidate => ({
  idemKey: "111:image:a", postId: "111", stableContentId: "image:a", contentType: "photo",
  url: "https://downloads.fanbox.cc/images/post/111/a.jpeg", basePath: "fanbox/s/T/a.jpeg",
  refetch: { postId: "111", stableContentId: "image:a", index: 0 }, ...over,
});

describe("applyEnqueue", () => {
  it("新規は generation 0 の pending + lease で toStart に載る", () => {
    const r = applyEnqueue(emptyLedger(), [cand()], opts());
    expect(r.toStart).toHaveLength(1);
    const j = r.ledger.jobs["111:image:a"];
    expect(j.state).toBe("pending");
    expect(j.generation).toBe(0);
    expect(j.relPath).toBe("fanbox/s/T/a.jpeg");
    expect(j.leaseToken).toBeTruthy();
    expect(j.pendingPostUpdatedAt).toBe("2026-07-02T00:00:00+09:00");
  });

  it("dedup: done + url + relPath 一致はスキップ", () => {
    const l1 = applyEnqueue(emptyLedger(), [cand()], opts()).ledger;
    const done: Ledger = { ...l1, jobs: { ...l1.jobs, "111:image:a": { ...l1.jobs["111:image:a"], state: "done", doneAt: 1, lastDownloadedPostUpdatedAt: "2026-07-02T00:00:00+09:00", leaseToken: undefined } } };
    const r = applyEnqueue(done, [cand()], opts());
    expect(r.toStart).toHaveLength(0);
    expect(r.skippedDedup).toEqual(["111:image:a"]);
  });

  it("stale-miss: url が変わったら単一ミューテーションで世代交代 (spec §7c-2)", () => {
    const l1 = applyEnqueue(emptyLedger(), [cand()], opts()).ledger;
    const done: Ledger = { ...l1, jobs: { ...l1.jobs, "111:image:a": { ...l1.jobs["111:image:a"], state: "done", doneAt: 1, leaseToken: undefined } } };
    const r = applyEnqueue(done, [cand({ url: "https://downloads.fanbox.cc/images/post/111/NEW.jpeg" })], opts());
    expect(r.toStart).toHaveLength(1);
    const j = r.ledger.jobs["111:image:a"];
    expect(j.generation).toBe(1);
    expect(j.relPath).toBe("fanbox/s/T/a.rev1.jpeg");
    expect(j.supersededUrl).toContain("/a.jpeg");
    expect(j.state).toBe("pending");
  });

  it("relPath だけ変わっても($seq 変動等)世代交代する (spec §8)", () => {
    const l1 = applyEnqueue(emptyLedger(), [cand()], opts()).ledger;
    const done: Ledger = { ...l1, jobs: { ...l1.jobs, "111:image:a": { ...l1.jobs["111:image:a"], state: "done", leaseToken: undefined } } };
    const r = applyEnqueue(done, [cand({ basePath: "fanbox/s/T2/a.jpeg" })], opts());
    expect(r.toStart[0].relPath).toBe("fanbox/s/T2/a.rev1.jpeg");
  });

  it("pathDivergent な done は dedup の権威にならず、次世代 .revN を発行 (spec §7c-2)", () => {
    const l1 = applyEnqueue(emptyLedger(), [cand()], opts()).ledger;
    const div: Ledger = { ...l1, jobs: { ...l1.jobs, "111:image:a": { ...l1.jobs["111:image:a"], state: "done", pathDivergent: true, leaseToken: undefined } } };
    const r = applyEnqueue(div, [cand()], opts());
    expect(r.toStart).toHaveLength(1);
    expect(r.toStart[0].generation).toBe(1);
    expect(r.toStart[0].relPath).toBe("fanbox/s/T/a.rev1.jpeg");
  });

  it("再入規則: pending 一致中の再 enqueue は download 二重発行しない (spec §7c-2 レース)", () => {
    const r1 = applyEnqueue(emptyLedger(), [cand()], opts());
    const r2 = applyEnqueue(r1.ledger, [cand()], opts());
    expect(r2.toStart).toHaveLength(0);
    // lease が張り替えられていないこと
    expect(r2.ledger.jobs["111:image:a"].leaseToken).toBe(r1.ledger.jobs["111:image:a"].leaseToken);
  });

  it("再入規則: 進行中で {url,relPath} 不一致は inFlightBlocked(自動置換禁止)", () => {
    const r1 = applyEnqueue(emptyLedger(), [cand()], opts());
    const r2 = applyEnqueue(r1.ledger, [cand({ url: "https://downloads.fanbox.cc/images/post/111/NEW.jpeg" })], opts());
    expect(r2.toStart).toHaveLength(0);
    expect(r2.inFlightBlocked).toEqual(["111:image:a"]);
  });

  it("force は done も進行中(解決済み前提)も世代交代スワップ", () => {
    const l1 = applyEnqueue(emptyLedger(), [cand()], opts()).ledger;
    const done: Ledger = { ...l1, jobs: { ...l1.jobs, "111:image:a": { ...l1.jobs["111:image:a"], state: "done", leaseToken: undefined } } };
    const r = applyEnqueue(done, [cand()], opts({ force: true }));
    expect(r.toStart).toHaveLength(1);
    expect(r.toStart[0].generation).toBe(1);
  });

  it("updatedDatetime 警告: dedup 成立でも投稿が更新されていれば warn し、lastWarned だけ進む (spec §8)", () => {
    const l1 = applyEnqueue(emptyLedger(), [cand()], opts()).ledger;
    const done: Ledger = { ...l1, jobs: { ...l1.jobs, "111:image:a": { ...l1.jobs["111:image:a"], state: "done", lastDownloadedPostUpdatedAt: "2026-07-02T00:00:00+09:00", leaseToken: undefined } } };
    const newer = opts({ postUpdatedAt: "2026-07-05T00:00:00+09:00" });
    const r1 = applyEnqueue(done, [cand()], newer);
    expect(r1.skippedDedup).toEqual(["111:image:a"]);
    expect(r1.staleWarnings).toEqual(["111:image:a"]);
    const j1 = r1.ledger.jobs["111:image:a"];
    expect(j1.lastWarnedPostUpdatedAt).toBe("2026-07-05T00:00:00+09:00");
    expect(j1.lastDownloadedPostUpdatedAt).toBe("2026-07-02T00:00:00+09:00"); // 進まない
    // 同じ updatedDatetime では再警告しない
    const r2 = applyEnqueue(r1.ledger, [cand()], newer);
    expect(r2.staleWarnings).toEqual([]);
    // さらに新しい更新が来れば再警告(見逃し→再更新→再通知 spec §8)
    const r3 = applyEnqueue(r2.ledger, [cand()], opts({ postUpdatedAt: "2026-07-09T00:00:00+09:00" }));
    expect(r3.staleWarnings).toEqual(["111:image:a"]);
  });

  it("tombstone を初期 generation として引き継ぐ (spec §7c-2 prune 耐性)", () => {
    const l: Ledger = { jobs: {}, generations: { "111:image:a": 3 } };
    const r = applyEnqueue(l, [cand()], opts());
    expect(r.toStart[0].generation).toBe(3);
    expect(r.toStart[0].relPath).toBe("fanbox/s/T/a.rev3.jpeg");
  });

  it("パス検証エラーはレコードを作らず errors に積む", () => {
    const r = applyEnqueue(emptyLedger(), [cand()], opts({ validatePath: () => "too long" }));
    expect(r.toStart).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.ledger.jobs["111:image:a"]).toBeUndefined();
  });

  it("バッチ内 relPath 重複は 2 件目を errors に", () => {
    const r = applyEnqueue(emptyLedger(), [cand(), cand({ idemKey: "111:image:b", stableContentId: "image:b", url: "https://downloads.fanbox.cc/images/post/111/b.jpeg" })], opts());
    // basePath が同じなので 2 件目は重複
    expect(r.toStart).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });

  it("refusedUrl と同一 URL の error レコードは自動再投入されない (spec §7a)", () => {
    const l1 = applyEnqueue(emptyLedger(), [cand()], opts()).ledger;
    const refused: Ledger = { ...l1, jobs: { ...l1.jobs, "111:image:a": { ...l1.jobs["111:image:a"], state: "error", leaseToken: undefined, refusedUrl: cand().url, error: "拒否済み" } } };
    const r = applyEnqueue(refused, [cand()], opts());
    expect(r.toStart).toHaveLength(0);
    expect(r.errors.some((e) => e.includes("拒否済み"))).toBe(true);
    // URL が変われば(編集されれば)再投入できる
    const r2 = applyEnqueue(refused, [cand({ url: "https://downloads.fanbox.cc/images/post/111/NEW.jpeg" })], opts());
    expect(r2.toStart).toHaveLength(1);
  });

  it("入力 ledger を破壊しない(イミュータブル)", () => {
    const l0 = emptyLedger();
    applyEnqueue(l0, [cand()], opts());
    expect(l0.jobs).toEqual({});
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL

- [ ] **Step 3: 実装**

`src/background/ledger.ts`(このタスクでは型 + emptyLedger + applyEnqueue まで。Task 10 の関数はまだ書かない):

```ts
import { canonicalRelPath } from "../core/canonical-relpath";

// spec §7c-2: 単一キー(`jobs` storage key)に格納する ledger。
// あらゆる状態遷移は「読む -> 純粋変換 -> 1 回 set」で行う(このモジュールは変換のみ)。
export type JobState = "pending" | "requested" | "done" | "error" | "needs_page";

export interface JobRecord {
  idemKey: string;
  postId: string;
  stableContentId: string;
  contentType: string;
  relPath: string;
  url: string;
  generation: number;
  state: JobState;
  leaseToken?: string;
  leasedAt?: number;
  downloadId?: number;
  error?: string;
  doneAt?: number;
  terminalAt?: number;   // 全 terminal 遷移で記録(sweep/cap の順序に使う)
  refusedUrl?: string;   // 回復拒否済み URL(同一 URL の自動再投入禁止)
  actualFilename?: string;
  pathDivergent?: boolean;
  supersededUrl?: string;
  supersededAt?: number;
  pendingPostUpdatedAt?: string;
  lastDownloadedPostUpdatedAt?: string;
  lastWarnedPostUpdatedAt?: string;
  retriedNetwork?: boolean;
  refetch: { postId: string; stableContentId: string; index: number };
}

export interface Ledger {
  jobs: Record<string, JobRecord>;
  generations: Record<string, number>; // tombstone(spec §7c-2 prune 耐性)
}

export function emptyLedger(): Ledger {
  return { jobs: {}, generations: {} };
}

export interface EnqueueCandidate {
  idemKey: string; postId: string; stableContentId: string; contentType: string;
  url: string; basePath: string;
  refetch: { postId: string; stableContentId: string; index: number };
}

export interface EnqueueResult {
  ledger: Ledger;
  toStart: JobRecord[];
  skippedDedup: string[];
  inFlightBlocked: string[];
  staleWarnings: string[];
  errors: string[];
}

const TERMINAL: ReadonlySet<JobState> = new Set(["done", "error", "needs_page"]);

// 世代交代スワップ(stale-miss / force / divergent 共通)。同一パスに落ちる場合は
// さらに +1 して .revN の未使用パスへ離脱する(uniquify にパス決定権を渡さない)。
function nextGenerationPath(
  basePath: string, prevGen: number, prevRelPath: string | undefined,
): { generation: number; relPath: string } {
  let gen = prevGen + 1;
  let rel = canonicalRelPath(basePath, gen);
  if (prevRelPath !== undefined && rel === prevRelPath) {
    gen += 1;
    rel = canonicalRelPath(basePath, gen);
  }
  return { generation: gen, relPath: rel };
}

export function applyEnqueue(
  ledger: Ledger,
  candidates: EnqueueCandidate[],
  opts: {
    force: boolean;
    postUpdatedAt: string;
    now: number;
    newLeaseToken: () => string;
    validatePath: (relPath: string) => string | null;
    caps?: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number };
  },
): EnqueueResult {
  const jobs = { ...ledger.jobs };
  const result: EnqueueResult = {
    ledger: { jobs, generations: { ...ledger.generations } },
    toStart: [], skippedDedup: [], inFlightBlocked: [], staleWarnings: [], errors: [],
  };
  const batchPaths = new Set<string>();

  const mint = (cand: EnqueueCandidate, generation: number, relPath: string, prev?: JobRecord): JobRecord => ({
    idemKey: cand.idemKey, postId: cand.postId, stableContentId: cand.stableContentId,
    contentType: cand.contentType, relPath, url: cand.url, generation,
    state: "pending", leaseToken: opts.newLeaseToken(), leasedAt: opts.now,
    pendingPostUpdatedAt: opts.postUpdatedAt,
    supersededUrl: prev?.url, supersededAt: prev ? opts.now : undefined,
    lastDownloadedPostUpdatedAt: prev?.lastDownloadedPostUpdatedAt,
    lastWarnedPostUpdatedAt: prev?.lastWarnedPostUpdatedAt,
    refetch: cand.refetch,
  });

  const commitStart = (cand: EnqueueCandidate, rec: JobRecord): void => {
    const err = opts.validatePath(rec.relPath);
    if (err) { result.errors.push(`${rec.relPath}: ${err}`); return; }
    if (batchPaths.has(rec.relPath)) { result.errors.push(`バッチ内パス重複: ${rec.relPath}`); return; }
    batchPaths.add(rec.relPath);
    jobs[cand.idemKey] = rec;
    result.toStart.push(rec);
  };

  for (const cand of candidates) {
    const prev = jobs[cand.idemKey];
    const tombstone = result.ledger.generations[cand.idemKey];

    if (!prev) {
      const gen = tombstone ?? 0;
      commitStart(cand, mint(cand, gen, canonicalRelPath(cand.basePath, gen)));
      continue;
    }

    if (!TERMINAL.has(prev.state)) {
      // 進行中(spec §7c-2 再入規則)。force はこの関数に来る前に caller が解決済みにする
      // 契約だが、防御的に force でも swap する(cancel 済み前提)。
      if (opts.force) {
        const { generation, relPath } = nextGenerationPath(cand.basePath, prev.generation, prev.relPath);
        commitStart(cand, mint(cand, generation, relPath, prev));
      } else if (prev.url === cand.url && prev.relPath === canonicalRelPath(cand.basePath, prev.generation)) {
        result.skippedDedup.push(cand.idemKey); // 既にキュー済み/実行中
      } else {
        result.inFlightBlocked.push(cand.idemKey);
      }
      continue;
    }

    const dedupOk =
      prev.state === "done" &&
      prev.pathDivergent !== true &&
      prev.url === cand.url &&
      prev.relPath === canonicalRelPath(cand.basePath, prev.generation);

    if (dedupOk && !opts.force) {
      result.skippedDedup.push(cand.idemKey);
      const downloadedAt = prev.lastDownloadedPostUpdatedAt ?? "";
      if (opts.postUpdatedAt > downloadedAt && opts.postUpdatedAt !== prev.lastWarnedPostUpdatedAt) {
        result.staleWarnings.push(cand.idemKey);
        jobs[cand.idemKey] = { ...prev, lastWarnedPostUpdatedAt: opts.postUpdatedAt };
      }
      continue;
    }

    if (prev.state === "done" || opts.force) {
      // stale-miss / divergent / force -> 世代交代スワップ(単一ミューテーション内)
      const { generation, relPath } = nextGenerationPath(cand.basePath, prev.generation, prev.relPath);
      commitStart(cand, mint(cand, generation, relPath, prev));
      continue;
    }

    // error / needs_page の再クリック: 同世代で再 lease して再投入。
    // ただし回復が「サーバ拒否」と判定した URL(refusedUrl)への自動再投入は禁止
    // (spec §7a: 明示エラーに留める。URL が変われば = 編集されれば再投入できる)
    if (prev.state === "error" && prev.refusedUrl === cand.url) {
      result.errors.push(`${cand.idemKey}: サーバがダウンロードを拒否済みです(未加入の有料コンテンツの可能性)`);
      continue;
    }
    const gen = prev.generation;
    commitStart(cand, { ...mint(cand, gen, canonicalRelPath(cand.basePath, gen), prev), supersededUrl: prev.supersededUrl, supersededAt: prev.supersededAt });
  }

  // spec §7c-2: 挿入と同一ミューテーション内 prune(上限超過状態の ledger を返さない)
  return { ...result, ledger: applyPruneSweep(result.ledger, opts.now, opts.caps ?? {}) };
}

// Task 9 時点の一時 stub(pass-through)。Task 10 が本実装(件数上限・sweep・tombstone)に
// 置き換える。function 宣言なので applyEnqueue から前方参照できる。
export function applyPruneSweep(
  l: Ledger, _now: number,
  _caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  return l;
}
```

- [ ] **Step 4: green + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: ledger enqueue transform with dedup, generation swap and freshness warning" -m "spec §7c-2/§8 の中核: dedup 三条件(idemKey+url+canonical relPath)、stale-miss/force/divergent の世代交代、再入規則、updatedDatetime 二重フィールド警告、tombstone 継承を純粋変換として実装。"'
```

---

