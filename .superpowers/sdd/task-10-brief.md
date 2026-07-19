### Task 10: ledger 変換 B — lease/CAS・terminal・prune・clear・回復(TDD・spec §7c)

**Files:**
- Modify: `src/background/ledger.ts`(関数追加)
- Test: `tests/ledger-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 9 の型、`pathMatchesBoundary`(Task 7)
- Produces(すべて CAS: `leaseToken` 不一致は入力 ledger をそのまま返す=stale イベント無視):

```ts
export function applyDownloadStarted(l: Ledger, idemKey: string, leaseToken: string, downloadId: number): Ledger;          // pending -> requested
export function applyDownloadRequestFailed(l: Ledger, idemKey: string, leaseToken: string, error: string): Ledger;         // pending -> error
export function applyDownloadComplete(l: Ledger, idemKey: string, leaseToken: string, actualFilename: string, doneAt: number): Ledger; // -> done(+pathDivergent 判定, lastDownloadedPostUpdatedAt = pendingPostUpdatedAt)
export function applyDownloadInterrupted(l: Ledger, idemKey: string, leaseToken: string, action: FailureAction, error: string, newLeaseToken: () => string, now: number): Ledger;
  // retry_once: 未リトライなら retriedNetwork=true + 新 lease の pending(リトライ済みなら error)
  // needs_page / terminal_error: 各 state へ
export function applyNeedsPageRecovery(l: Ledger, postId: string, fresh: Array<{stableContentId: string; url: string; basePath: string}>, opts: {now: number; postUpdatedAt: string; newLeaseToken: () => string; validatePath: (p: string) => string | null; invalidIds?: Set<string>}): { ledger: Ledger; toStart: JobRecord[]; missing: string[]; refused: string[]; invalid: string[]; errors: string[] };
  // missing = stableContentId 一致の fresh が無い(「編集で消えた」)場合**だけ**。
  // パス検証エラーは errors(整形済み文言)、allowlist 違反は invalid、同一 URL 拒否は refused
  // postUpdatedAt: 今回 post.info の updatedDatetime。再バインドされた pending の
  // pendingPostUpdatedAt に刻む(完了時に lastDownloadedPostUpdatedAt へ昇格する鮮度契約 spec §8)。
  // opts.invalidIds: allowlist 違反で除外された stableContentId 集合。該当 needs_page は
  // 「編集で消えた」ではなく「メディア URL が許可外」の error にする(spec §4a: 既存ジョブは error にして明示通知)
  // needs_page レコードを stableContentId 一致で fresh に再バインド(url 更新+世代交代)。無ければ missing(明示エラー化)。
  // fresh の url が失敗時と同一(= 編集由来の失効ではない)なら再投入しない
  // (クリックごとに同じサーバ失敗を繰り返す無限ループの防止。spec §6)。
  // 中立の明示 terminal error にして refused に積む(有料 403 の明示エラーは classifier が担当)
export function applyClearTerminal(l: Ledger): Ledger;                    // done/error/needs_page のみ削除(gen>0 は tombstone へ)
export function applyPruneSweep(l: Ledger, now: number, caps?: {maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number}): Ledger;
export function findLeasesWithoutDownloadId(l: Ledger): JobRecord[];      // 起動時 reconcile / force 用
export function applyInvalidateByIds(l: Ledger, postId: string, invalidIds: Set<string>, now: number): { ledger: Ledger; invalidated: string[] };
  // spec §4a「既存ジョブなら error にして明示通知」: allowlist 違反となった stableContentId を持つ
  // 非 terminal / needs_page レコードを error(「メディア URL が許可外…」)に落とす。
  // done / error はそのまま(ネットワーク使用が発生しないため)。進行中で downloadId が
  // ある場合も error 化のみ行い、実 DL の cancel は呼び出し側(SW)の責務
// spec §4a: allowlist 違反 ID の既存ジョブを error 化する(needs_page 回復以外の経路)
export function applyInvalidateByIds(
  l: Ledger, postId: string, invalidIds: Set<string>, now: number,
): { ledger: Ledger; invalidated: string[] } {
  if (invalidIds.size === 0) return { ledger: l, invalidated: [] };
  const jobs = { ...l.jobs };
  const invalidated: string[] = [];
  for (const rec of Object.values(l.jobs)) {
    if (rec.postId !== postId || !invalidIds.has(rec.stableContentId)) continue;
    if (rec.state === "pending" || rec.state === "requested" || rec.state === "needs_page") {
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: now, leaseToken: undefined, leasedAt: undefined, error: "メディア URL が許可外のためダウンロードできません" };
      invalidated.push(rec.idemKey);
    }
  }
  return { ledger: applyPruneSweep({ ...l, jobs }, now, {}), invalidated };
}

export function applyReissueLease(l: Ledger, idemKey: string, oldToken: string, newToken: string, now: number): { ledger: Ledger; record: JobRecord | null };
  // 再投入(requeue)前の lease 再発行(spec §7c-2: leaseToken は requeue のたびに再発行)。
  // CAS: oldToken 不一致なら record: null(再投入しない)
```

**規則**: `applyClearTerminal` / `applyPruneSweep` で `generation > 0` のレコードを消すときは `generations[idemKey] = max(既存, generation)` を残す(spec §7c-2 tombstone)。tombstone は maxTombstones(既定 10,000)超過分を挿入順の古い方から削除。terminal 上限は doneAt/leasedAt の古い順に prune。
**同一ミューテーション内 prune(spec §7c-2・このタスクで配線)**: applyPruneSweep 実装後、
`applyEnqueue` の opts と `applyDownloadComplete` の引数に
`caps?: {maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number}` を optional で追加し、
両関数の**返却直前**に `applyPruneSweep(ledger, now, caps)` を通すパイプを入れる
(applyDownloadComplete は `doneAt` を now として使う。caps 省略時は spec 既定の
5,000 件 / 1 年 / 10,000 件)。これで「挿入と prune が同じ 1 回の set に含まれる」
spec 要求を満たす。`tests/ledger-lifecycle.test.ts` に追加するテスト:

```ts
  it("挿入と同一ミューテーションで prune される(上限超過 ledger を書かない) (spec §7c-2)", () => {
    // done 2 件(上限 2)の ledger に 3 件目の complete が来ると、同じ変換の返却値の
    // 時点で最古の done が prune されている(超過 ledger が一度も存在しない)
    const mkDone = (i: number): JobRecord => ({
      idemKey: `k${i}`, postId: "1", stableContentId: `image:${i}`, contentType: "photo",
      relPath: `p/${i}`, url: `u${i}`, generation: 0, state: "done", doneAt: 1000 + i,
      refetch: { postId: "1", stableContentId: `image:${i}`, index: 0 },
    });
    const seeded: Ledger = { jobs: { k1: mkDone(1), k2: mkDone(2) }, generations: {} };
    const r = applyEnqueue(seeded, [cand()], { ...baseOpts, caps: { maxTerminal: 2 } });
    const started = applyDownloadStarted(r.ledger, "111:image:a", r.toStart[0].leaseToken!, 5);
    const done = applyDownloadComplete(started, "111:image:a", r.toStart[0].leaseToken!, "/dl/fanbox/s/T/a.jpeg", 9999, { maxTerminal: 2 });
    const terminals = Object.values(done.jobs).filter((j) => j.state === "done");
    expect(terminals).toHaveLength(2);
    expect(done.jobs["k1"]).toBeUndefined(); // 最古が同一ミューテーション内で prune 済み
    expect(done.jobs["111:image:a"].state).toBe("done");
  });
```

(`applyDownloadComplete` のシグネチャは `(l, idemKey, leaseToken, actualFilename, doneAt, caps?)` に更新。Task 15 の呼び出し側は caps 省略でよい)

パイプは Task 9 のコードブロックに既に組み込み済み(applyEnqueue が返却直前に
applyPruneSweep を通し、Task 9 では pass-through stub)。このタスクでやることは
(a) stub を上の本実装に置き換える、(b) applyDownloadComplete(Step 3 のコード)が
caps 付きで prune を通していることを確認する、の 2 点。

- [ ] **Step 1: 失敗テストを書く**

`tests/ledger-lifecycle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyLedger, applyEnqueue, applyDownloadStarted, applyDownloadRequestFailed,
  applyDownloadComplete, applyDownloadInterrupted, applyNeedsPageRecovery,
  applyClearTerminal, applyPruneSweep, findLeasesWithoutDownloadId, applyInvalidateByIds,
  type Ledger, type JobRecord,
} from "../src/background/ledger";

let tok = 0;
const mkTok = () => `L${++tok}`;
const baseOpts = { force: false, postUpdatedAt: "2026-07-02T00:00:00+09:00", now: 10_000, newLeaseToken: mkTok, validatePath: () => null };
const cand = () => ({
  idemKey: "111:image:a", postId: "111", stableContentId: "image:a", contentType: "photo",
  url: "https://downloads.fanbox.cc/images/post/111/a.jpeg", basePath: "fanbox/s/T/a.jpeg",
  refetch: { postId: "111", stableContentId: "image:a", index: 0 },
});
const enq = (): { l: Ledger; token: string } => {
  const r = applyEnqueue(emptyLedger(), [cand()], baseOpts);
  return { l: r.ledger, token: r.toStart[0].leaseToken! };
};

describe("lease/CAS ライフサイクル", () => {
  it("started: pending -> requested + downloadId", () => {
    const { l, token } = enq();
    const l2 = applyDownloadStarted(l, "111:image:a", token, 42);
    expect(l2.jobs["111:image:a"].state).toBe("requested");
    expect(l2.jobs["111:image:a"].downloadId).toBe(42);
  });
  it("CAS: leaseToken 不一致の解決イベントは無視される (spec §7c-2 必須テスト)", () => {
    const { l, token } = enq();
    // lease A を force スワップで lease B に置換した後、A の遅延解決が届く
    const swapped = applyEnqueue(l, [cand()], { ...baseOpts, force: true }).ledger;
    const before = swapped.jobs["111:image:a"];
    const after = applyDownloadStarted(swapped, "111:image:a", token, 99); // 旧 token A
    expect(after.jobs["111:image:a"]).toEqual(before); // B は不変
    const after2 = applyDownloadComplete(swapped, "111:image:a", token, "/dl/x.jpg", 1);
    expect(after2.jobs["111:image:a"]).toEqual(before);
  });
  it("complete: done + lastDownloadedPostUpdatedAt が pending 時の値に進む", () => {
    const { l, token } = enq();
    const l2 = applyDownloadComplete(applyDownloadStarted(l, "111:image:a", token, 1), "111:image:a", token, "/dl/fanbox/s/T/a.jpeg", 500);
    const j = l2.jobs["111:image:a"];
    expect(j.state).toBe("done");
    expect(j.doneAt).toBe(500);
    expect(j.lastDownloadedPostUpdatedAt).toBe("2026-07-02T00:00:00+09:00");
    expect(j.pathDivergent).toBeFalsy();
    expect(j.leaseToken).toBeUndefined(); // terminal に lease は無い
  });
  it("complete: actualFilename が relPath と境界一致しなければ pathDivergent (spec §7c-2)", () => {
    const { l, token } = enq();
    const l2 = applyDownloadComplete(applyDownloadStarted(l, "111:image:a", token, 1), "111:image:a", token, "/dl/fanbox/s/T/a (1).jpeg", 500);
    expect(l2.jobs["111:image:a"].pathDivergent).toBe(true);
    expect(l2.jobs["111:image:a"].actualFilename).toBe("/dl/fanbox/s/T/a (1).jpeg");
  });
  it("interrupted + retry_once: 1 回だけ新 lease の pending に戻る", () => {
    const { l, token } = enq();
    const started = applyDownloadStarted(l, "111:image:a", token, 1);
    const l2 = applyDownloadInterrupted(started, "111:image:a", token, "retry_once", "NETWORK_FAILED", mkTok, 20_000);
    const j = l2.jobs["111:image:a"];
    expect(j.state).toBe("pending");
    expect(j.retriedNetwork).toBe(true);
    expect(j.leaseToken).not.toBe(token);
    // 2 回目の NETWORK は terminal error
    const l3 = applyDownloadInterrupted(applyDownloadStarted(l2, "111:image:a", j.leaseToken!, 2), "111:image:a", j.leaseToken!, "retry_once", "NETWORK_FAILED", mkTok, 30_000);
    expect(l3.jobs["111:image:a"].state).toBe("error");
  });
  it("SERVER_FORBIDDEN の terminal は spec の明示文言 + refusedUrl を刻む (spec §6/§7a)", () => {
    const { l, token } = enq();
    const started = applyDownloadStarted(l, "111:image:a", token, 1);
    const after = applyDownloadInterrupted(started, "111:image:a", token, "terminal_error", "SERVER_FORBIDDEN", mkTok, 0);
    expect(after.jobs["111:image:a"].state).toBe("error");
    expect(after.jobs["111:image:a"].refusedUrl).toBe(after.jobs["111:image:a"].url);
    expect(after.jobs["111:image:a"].error).toContain("未加入の有料コンテンツの可能性");
    expect(after.jobs["111:image:a"].error).toContain("SERVER_FORBIDDEN"); // raw code も診断用に残す
  });

  it("interrupted + needs_page / terminal_error", () => {
    const { l, token } = enq();
    const started = applyDownloadStarted(l, "111:image:a", token, 1);
    expect(applyDownloadInterrupted(started, "111:image:a", token, "needs_page", "SERVER_BAD_CONTENT", mkTok, 0).jobs["111:image:a"].state).toBe("needs_page");
    expect(applyDownloadInterrupted(started, "111:image:a", token, "terminal_error", "USER_CANCELED", mkTok, 0).jobs["111:image:a"].state).toBe("error");
  });
});

describe("needs_page 回復 (spec §6 / §14-2)", () => {
  const toNeedsPage = (): Ledger => {
    const { l, token } = enq();
    return applyDownloadInterrupted(applyDownloadStarted(l, "111:image:a", token, 1), "111:image:a", token, "needs_page", "SERVER_BAD_CONTENT", mkTok, 0);
  };
  it("stableContentId 一致で新 URL に再バインド(世代交代)", () => {
    const r = applyNeedsPageRecovery(toNeedsPage(), "111",
      [{ stableContentId: "image:a", url: "https://downloads.fanbox.cc/images/post/111/NEW.jpeg", basePath: "fanbox/s/T/NEW.jpeg" }],
      { now: 50_000, postUpdatedAt: "2026-07-09T00:00:00+09:00", newLeaseToken: mkTok, validatePath: () => null });
    expect(r.toStart).toHaveLength(1);
    expect(r.missing).toEqual([]);
    const j = r.ledger.jobs["111:image:a"];
    expect(j.state).toBe("pending");
    expect(j.url).toContain("NEW");
    expect(j.generation).toBe(1);
    expect(j.pendingPostUpdatedAt).toBe("2026-07-09T00:00:00+09:00"); // 鮮度契約(spec §8)
  });
  it("必須フィクスチャ2: 編集・並べ替え後も安定 ID で正しく再バインドされる (spec §14-2)", () => {
    // needs_page が 2 本(a, b)。回復時の fresh は順序が逆転し、b は消えている
    const two = applyEnqueue(emptyLedger(), [cand(), { ...cand(), idemKey: "111:image:b", stableContentId: "image:b", url: "https://downloads.fanbox.cc/images/post/111/b.jpeg", basePath: "fanbox/s/T/b.jpeg", refetch: { postId: "111", stableContentId: "image:b", index: 1 } }], baseOpts);
    let l: Ledger = two.ledger;
    for (const j of two.toStart) {
      l = applyDownloadStarted(l, j.idemKey, j.leaseToken!, 1);
      l = applyDownloadInterrupted(l, j.idemKey, j.leaseToken!, "needs_page", "SERVER_BAD_CONTENT", mkTok, 0);
    }
    const r = applyNeedsPageRecovery(l, "111",
      [ // 並べ替え済み + b 欠落 + 無関係の新規 c
        { stableContentId: "image:c", url: "https://downloads.fanbox.cc/images/post/111/c.jpeg", basePath: "fanbox/s/T/c.jpeg" },
        { stableContentId: "image:a", url: "https://downloads.fanbox.cc/images/post/111/a2.jpeg", basePath: "fanbox/s/T/a2.jpeg" },
      ],
      { now: 50_000, postUpdatedAt: "x", newLeaseToken: mkTok, validatePath: () => null });
    expect(r.toStart.map(j => j.idemKey)).toEqual(["111:image:a"]); // 順序ではなく ID で結ぶ
    expect(r.ledger.jobs["111:image:a"].url).toContain("a2");
    expect(r.missing).toEqual(["111:image:b"]);
    expect(r.ledger.jobs["111:image:b"].state).toBe("error");
  });

  it("fresh の URL が失敗時と同一なら再投入せず中立の明示エラー(クリックごとループの防止 spec §6)", () => {
    const l = toNeedsPage();
    const failedUrl = l.jobs["111:image:a"].url;
    const r = applyNeedsPageRecovery(l, "111",
      [{ stableContentId: "image:a", url: failedUrl, basePath: "fanbox/s/T/a.jpeg" }],
      { now: 50_000, postUpdatedAt: "x", newLeaseToken: mkTok, validatePath: () => null });
    expect(r.toStart).toEqual([]);
    expect(r.refused).toEqual(["111:image:a"]);
    expect(r.ledger.jobs["111:image:a"].state).toBe("error");
    expect(r.ledger.jobs["111:image:a"].error).toContain("続いています");
    expect(r.ledger.jobs["111:image:a"].refusedUrl).toBe(failedUrl);
  });

  it("applyInvalidateByIds: 進行中/needs_page の既存ジョブを許可外 error に落とす (spec §4a)", () => {
    const { l } = enq(); // pending
    const r = applyInvalidateByIds(l, "111", new Set(["image:a"]), 99);
    expect(r.invalidated).toEqual(["111:image:a"]);
    expect(r.ledger.jobs["111:image:a"].state).toBe("error");
    expect(r.ledger.jobs["111:image:a"].error).toContain("許可外");
    // done はそのまま(ネットワーク使用が無いため)
    const { l: l2, token } = enq();
    const done = applyDownloadComplete(applyDownloadStarted(l2, "111:image:a", token, 1), "111:image:a", token, "/dl/fanbox/s/T/a.jpeg", 1);
    const r2 = applyInvalidateByIds(done, "111", new Set(["image:a"]), 99);
    expect(r2.invalidated).toEqual([]);
    expect(r2.ledger.jobs["111:image:a"].state).toBe("done");
  });

  it("allowlist 違反の needs_page は『編集で消えた』ではなく許可外エラーになる (spec §4a)", () => {
    const r = applyNeedsPageRecovery(toNeedsPage(), "111",
      [],
      { now: 50_000, postUpdatedAt: "x", newLeaseToken: mkTok, validatePath: () => null, invalidIds: new Set(["image:a"]) });
    expect(r.ledger.jobs["111:image:a"].state).toBe("error");
    expect(r.ledger.jobs["111:image:a"].error).toContain("許可外");
    expect(r.invalid).toEqual(["111:image:a"]); // missing とは区別して返す(SW が別文言で通知)
    expect(r.missing).toEqual([]);
  });

  it("編集で消えた ID は missing(明示エラー・ordinal 誤バインド禁止)", () => {
    const r = applyNeedsPageRecovery(toNeedsPage(), "111",
      [{ stableContentId: "image:OTHER", url: "https://downloads.fanbox.cc/images/post/111/o.jpeg", basePath: "p" }],
      { now: 50_000, postUpdatedAt: "x", newLeaseToken: mkTok, validatePath: () => null });
    expect(r.toStart).toEqual([]);
    expect(r.missing).toEqual(["111:image:a"]);
    expect(r.ledger.jobs["111:image:a"].state).toBe("error");
  });
});

describe("clear / prune / tombstone (spec §7c-2/§7c-3)", () => {
  it("clearTerminal は terminal のみ削除し、進行中を残し、gen>0 は tombstone 化", () => {
    const { l, token } = enq();
    const done = applyDownloadComplete(applyDownloadStarted(l, "111:image:a", token, 1), "111:image:a", token, "/dl/fanbox/s/T/a.jpeg", 1);
    // 2 本目: 進行中のまま
    const both = applyEnqueue(done, [{ ...cand(), idemKey: "111:image:b", stableContentId: "image:b", url: "https://downloads.fanbox.cc/images/post/111/b.jpeg", basePath: "fanbox/s/T/b.jpeg" }], baseOpts).ledger;
    const gen1: Ledger = { ...both, jobs: { ...both.jobs, "111:image:a": { ...both.jobs["111:image:a"], generation: 2 } } };
    const cleared = applyClearTerminal(gen1);
    expect(cleared.jobs["111:image:a"]).toBeUndefined();
    expect(cleared.jobs["111:image:b"]).toBeDefined(); // 進行中は残す
    expect(cleared.generations["111:image:a"]).toBe(2); // tombstone
  });
  it("lease 窓中の clear: 未解決 lease(pending)のレコードは削除されない (spec §7c-3 必須テスト)", () => {
    const { l } = enq(); // pending + lease(downloadId 未永続 = lease 窓)
    const cleared = applyClearTerminal(l);
    expect(cleared.jobs["111:image:a"]).toBeDefined();
    expect(cleared.jobs["111:image:a"].state).toBe("pending");
    expect(cleared.jobs["111:image:a"].leaseToken).toBeTruthy(); // lease はそのまま
  });

  it("pruneSweep: 1 年超の done を削除・terminal 上限で古い順に prune", () => {
    let l = emptyLedger();
    const YEAR = 365 * 24 * 3600 * 1000;
    const mk = (i: number, doneAt: number): JobRecord => ({
      idemKey: `k${i}`, postId: "1", stableContentId: `image:${i}`, contentType: "photo",
      relPath: `p/${i}`, url: `u${i}`, generation: 0, state: "done", doneAt,
      refetch: { postId: "1", stableContentId: `image:${i}`, index: 0 },
    });
    const jobs: Record<string, JobRecord> = {};
    jobs["old"] = { ...mk(999, 0), idemKey: "old" };            // 1 年超
    for (let i = 0; i < 3; i++) jobs[`k${i}`] = mk(i, 2_000_000 + i);
    l = { jobs, generations: {} };
    const swept = applyPruneSweep(l, 2 * YEAR, { maxTerminal: 2, maxAgeMs: YEAR, maxTombstones: 10 });
    expect(swept.jobs["old"]).toBeUndefined();
    // 残り 3 件 -> 上限 2 -> 最古 k0 が prune
    expect(swept.jobs["k0"]).toBeUndefined();
    expect(swept.jobs["k1"]).toBeDefined();
    expect(swept.jobs["k2"]).toBeDefined();
  });
  it("tombstone 喪失時のフォールバック連鎖: パス再利用 -> pathDivergent -> 世代インクリメントで収束 (spec §7c-2 テスト対象)", () => {
    // gen 2 の done レコードを clearTerminal で tombstone 化し、maxTombstones=1 の prune で
    // 別 idemKey の tombstone に押し出させて喪失させる
    const { l, token } = enq();
    const done = applyDownloadComplete(applyDownloadStarted(l, "111:image:a", token, 1), "111:image:a", token, "/dl/fanbox/s/T/a.jpeg", 1);
    const gen2: Ledger = { ...done, jobs: { ...done.jobs, "111:image:a": { ...done.jobs["111:image:a"], generation: 2 } } };
    let cleared = applyClearTerminal(gen2);
    expect(cleared.generations["111:image:a"]).toBe(2);
    // 後から入った別 tombstone で cap を溢れさせる(挿入順の古い方 = image:a が消える)
    cleared = { ...cleared, generations: { ...cleared.generations, "999:image:z": 1 } };
    const evicted = applyPruneSweep(cleared, 10, { maxTombstones: 1 });
    expect(evicted.generations["111:image:a"]).toBeUndefined(); // tombstone 喪失
    // 再 enqueue は gen 0 = 素のパスを再利用してしまう(ここまでが想定される劣化)
    const re = applyEnqueue(evicted, [cand()], baseOpts);
    expect(re.toStart[0].generation).toBe(0);
    // Chrome が uniquify で逃がした(= actualFilename 乖離)-> pathDivergent
    const t2 = re.toStart[0].leaseToken!;
    const div = applyDownloadComplete(applyDownloadStarted(re.ledger, "111:image:a", t2, 3), "111:image:a", t2, "/dl/fanbox/s/T/a (1).jpeg", 20);
    expect(div.jobs["111:image:a"].pathDivergent).toBe(true);
    // divergent 起点の次 enqueue は世代をインクリメントして未使用の .revN に離脱(静かな破壊にならない)
    const rec2 = applyEnqueue(div, [cand()], baseOpts);
    expect(rec2.toStart).toHaveLength(1);
    expect(rec2.toStart[0].generation).toBe(1);
    expect(rec2.toStart[0].relPath).toBe("fanbox/s/T/a.rev1.jpeg");
  });

  it("findLeasesWithoutDownloadId は pending の lease 残りを返す", () => {
    const { l } = enq();
    expect(findLeasesWithoutDownloadId(l).map(j => j.idemKey)).toEqual(["111:image:a"]);
  });
  it("SW 再起動シナリオ: 世代交代済み pending が単独で存在し誤回収されない (spec §7c-2 必須テスト)", () => {
    const { l, token } = enq();
    const done = applyDownloadComplete(applyDownloadStarted(l, "111:image:a", token, 1), "111:image:a", token, "/dl/fanbox/s/T/a.jpeg", 1);
    const swapped = applyEnqueue(done, [{ ...cand(), url: "https://downloads.fanbox.cc/images/post/111/NEW.jpeg" }], baseOpts).ledger;
    // 「再起動」= ledger をそのまま読み直しても pending 1 本だけ。回収規則は不要
    expect(Object.keys(swapped.jobs)).toEqual(["111:image:a"]);
    expect(swapped.jobs["111:image:a"].state).toBe("pending");
    // prune/sweep をかけても pending は消えない
    const swept = applyPruneSweep(swapped, Date.now(), {});
    expect(swept.jobs["111:image:a"].state).toBe("pending");
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL(関数未実装)

- [ ] **Step 3: 実装(ledger.ts に追記。Task 9 の `applyPruneSweep` **stub を本実装に置き換える**)**

```ts
import { pathMatchesBoundary } from "./adoption";
import type { FailureAction } from "./failure-classifier";

// --- CAS ヘルパ: leaseToken 不一致(旧世代の stale イベント)は ledger を変えずに返す ---
function withCas(
  l: Ledger, idemKey: string, leaseToken: string,
  f: (rec: JobRecord) => JobRecord,
): Ledger {
  const rec = l.jobs[idemKey];
  if (!rec || rec.leaseToken !== leaseToken) return l; // stale イベント無視(spec §7c-2 CAS)
  return { ...l, jobs: { ...l.jobs, [idemKey]: f(rec) } };
}

export function applyDownloadStarted(l: Ledger, idemKey: string, leaseToken: string, downloadId: number): Ledger {
  return withCas(l, idemKey, leaseToken, (r) => ({ ...r, state: "requested", downloadId }));
}

export function applyDownloadRequestFailed(l: Ledger, idemKey: string, leaseToken: string, error: string, now?: number): Ledger {
  const next = withCas(l, idemKey, leaseToken, (r) => ({ ...r, state: "error", error, terminalAt: now ?? r.leasedAt, leaseToken: undefined }));
  if (next === l) return l;
  // spec §7c-2: terminal レコードを作る遷移も同一ミューテーション内で prune
  return applyPruneSweep(next, now ?? 0, {});
}

export function applyDownloadComplete(
  l: Ledger, idemKey: string, leaseToken: string, actualFilename: string, doneAt: number,
  caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  const next = withCas(l, idemKey, leaseToken, (r) => ({
    ...r,
    state: "done", doneAt, terminalAt: doneAt, actualFilename,
    pathDivergent: pathMatchesBoundary(actualFilename, r.relPath) ? undefined : true,
    lastDownloadedPostUpdatedAt: r.pendingPostUpdatedAt ?? r.lastDownloadedPostUpdatedAt,
    leaseToken: undefined, leasedAt: undefined, retriedNetwork: undefined,
  }));
  if (next === l) return l; // CAS 不成立(stale)なら prune もしない
  // spec §7c-2: terminal レコードの挿入と同一ミューテーション内 prune
  return applyPruneSweep(next, doneAt, caps);
}

export function applyDownloadInterrupted(
  l: Ledger, idemKey: string, leaseToken: string,
  action: FailureAction, error: string,
  newLeaseToken: () => string, now: number,
  caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  const next = withCas(l, idemKey, leaseToken, (r) => {
    if (action === "retry_once" && !r.retriedNetwork) {
      // 有界リトライ 1 回(spec §6): 新 lease で pending に戻す
      return { ...r, state: "pending", retriedNetwork: true, leaseToken: newLeaseToken(), leasedAt: now, downloadId: undefined, error };
    }
    if (action === "needs_page") {
      return { ...r, state: "needs_page", error, terminalAt: now, leaseToken: undefined, leasedAt: undefined };
    }
    // SERVER_FORBIDDEN(有料 403)は spec §6 の明示文言でレコードに残す(raw code は併記)。
    // refusedUrl も刻み、同一 URL の自動再投入(applyEnqueue の error 再投入分岐)を禁止する。
    if (error === "SERVER_FORBIDDEN") {
      return {
        ...r, state: "error", terminalAt: now, refusedUrl: r.url,
        error: "サーバがダウンロードを拒否しました(未加入の有料コンテンツの可能性)(SERVER_FORBIDDEN)",
        leaseToken: undefined, leasedAt: undefined,
      };
    }
    return { ...r, state: "error", error, terminalAt: now, leaseToken: undefined, leasedAt: undefined };
  });
  if (next === l) return l;
  // spec §7c-2: terminal レコードを作る遷移も同一ミューテーション内で prune
  const rec = next.jobs[idemKey];
  return rec && (rec.state === "error" || rec.state === "needs_page") ? applyPruneSweep(next, now, caps) : next;
}

export function applyNeedsPageRecovery(
  l: Ledger, postId: string,
  fresh: Array<{ stableContentId: string; url: string; basePath: string }>,
  opts: { now: number; postUpdatedAt: string; newLeaseToken: () => string; validatePath: (p: string) => string | null; invalidIds?: Set<string> },
): { ledger: Ledger; toStart: JobRecord[]; missing: string[]; refused: string[]; invalid: string[]; errors: string[] } {
  const jobs = { ...l.jobs };
  const toStart: JobRecord[] = [];
  const missing: string[] = [];
  const refused: string[] = [];
  const invalid: string[] = [];
  const errors: string[] = [];
  const byId = new Map(fresh.map((f) => [f.stableContentId, f]));
  for (const rec of Object.values(l.jobs)) {
    if (rec.postId !== postId || rec.state !== "needs_page") continue;
    if (opts.invalidIds?.has(rec.stableContentId)) {
      // spec §4a: allowlist 違反は「編集で消えた」と区別して明示 error にする
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, error: "メディア URL が許可外のためダウンロードできません" };
      invalid.push(rec.idemKey);
      continue;
    }
    const f = byId.get(rec.stableContentId); // 安定 ID 一致のみ(ordinal 誤バインド禁止 spec §6)
    if (!f) {
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, error: "投稿が編集され該当ファイルは存在しない" };
      missing.push(rec.idemKey);
      continue;
    }
    if (f.url === rec.url) {
      // URL が変わっていない = 編集由来の失効ではない。再投入しても同じサーバ失敗を
      // 繰り返すだけなので中立の明示 terminal error にする(spec §6)。
      // refusedUrl を刻み、後続 applyEnqueue の error 再投入分岐がこの URL を
      // 自動再投入することも禁止する(拒否が同クリックで巻き戻る矛盾の防止)。
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, refusedUrl: rec.url, error: "同じ URL のままサーバ側の失敗が続いています。時間を置いて再試行してください" };
      refused.push(rec.idemKey);
      continue;
    }
    // 世代交代の canonical パス規則は回復経路にも適用(spec §7c-2「世代交代全般」)
    const { generation: gen, relPath } = nextGenerationPath(f.basePath, rec.generation, rec.relPath);
    const err = opts.validatePath(relPath);
    if (err) {
      // パス検証エラーは「編集で消えた」とは別種の失敗として errors に整形済み文言で積む
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, error: `${relPath}: ${err}` };
      errors.push(`${rec.idemKey}: パス検証エラー ${relPath}: ${err}`);
      continue;
    }
    const next: JobRecord = {
      ...rec, state: "pending", url: f.url, relPath, generation: gen,
      leaseToken: opts.newLeaseToken(), leasedAt: opts.now, downloadId: undefined,
      pendingPostUpdatedAt: opts.postUpdatedAt,
      supersededUrl: rec.url, supersededAt: opts.now, error: undefined, retriedNetwork: undefined,
      terminalAt: undefined, refusedUrl: undefined,
    };
    jobs[rec.idemKey] = next;
    toStart.push(next);
  }
  // spec §7c-2: 回復も terminal(error)レコードを作り得るため同一ミューテーション内で prune
  const pruned = applyPruneSweep({ ...l, jobs }, opts.now, {});
  return { ledger: pruned, toStart, missing, refused, invalid, errors };
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["done", "error", "needs_page"]);

function tombstoneInto(generations: Record<string, number>, rec: JobRecord): void {
  if (rec.generation > 0) {
    generations[rec.idemKey] = Math.max(generations[rec.idemKey] ?? 0, rec.generation);
  }
}

function capTombstones(generations: Record<string, number>, max: number): Record<string, number> {
  const keys = Object.keys(generations);
  if (keys.length <= max) return generations;
  // 挿入順の古い方から削除(Object のキー順 = 挿入順)。喪失時の最悪ケースは
  // divergent 回復チェーンで収束する(spec §7c-2)。
  const out: Record<string, number> = {};
  for (const k of keys.slice(keys.length - max)) out[k] = generations[k];
  return out;
}

export function applyClearTerminal(l: Ledger): Ledger {
  const jobs: Record<string, JobRecord> = {};
  const generations = { ...l.generations };
  for (const rec of Object.values(l.jobs)) {
    if (TERMINAL_STATES.has(rec.state)) tombstoneInto(generations, rec);
    else jobs[rec.idemKey] = rec; // 進行中は terminal になるまで残す(spec §7c-3)
  }
  return { jobs, generations: capTombstones(generations, 10_000) };
}

export function applyPruneSweep(
  l: Ledger, now: number,
  caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  const maxTerminal = caps.maxTerminal ?? 5_000;
  const maxAgeMs = caps.maxAgeMs ?? 365 * 24 * 3600 * 1000;
  const maxTombstones = caps.maxTombstones ?? 10_000;
  const jobs = { ...l.jobs };
  const generations = { ...l.generations };
  const drop = (rec: JobRecord) => { tombstoneInto(generations, rec); delete jobs[rec.idemKey]; };

  const terminalTime = (r: JobRecord) => r.terminalAt ?? r.doneAt ?? r.leasedAt ?? 0;
  for (const rec of Object.values(l.jobs)) {
    // spec §7c-2: sweep は done に限らず全 terminal(古い error/needs_page も掃除できる)
    if (TERMINAL_STATES.has(rec.state) && now - terminalTime(rec) > maxAgeMs) drop(rec);
  }
  const terminals = Object.values(jobs)
    .filter((r) => TERMINAL_STATES.has(r.state))
    .sort((a, b) => terminalTime(a) - terminalTime(b));
  for (let i = 0; i < terminals.length - maxTerminal; i++) drop(terminals[i]);

  return { jobs, generations: capTombstones(generations, maxTombstones) };
}

export function findLeasesWithoutDownloadId(l: Ledger): JobRecord[] {
  return Object.values(l.jobs).filter((r) => r.state === "pending" && r.leaseToken !== undefined && r.downloadId === undefined);
}

// spec §7c-2: requeue のたびに leaseToken を再発行する(旧 lease の遅延解決が
// 新試行を汚染しないための CAS 前提)。reconcile の再投入はここを必ず通す。
export function applyReissueLease(
  l: Ledger, idemKey: string, oldToken: string, newToken: string, now: number,
): { ledger: Ledger; record: JobRecord | null } {
  const rec = l.jobs[idemKey];
  if (!rec || rec.leaseToken !== oldToken) return { ledger: l, record: null };
  const next: JobRecord = { ...rec, state: "pending", leaseToken: newToken, leasedAt: now, downloadId: undefined };
  return { ledger: { ...l, jobs: { ...l.jobs, [idemKey]: next } }, record: next };
}
```

- [ ] **Step 4: green + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: ledger lifecycle transforms with CAS guard, recovery, prune and tombstones" -m "spec §7c: leaseToken CAS による stale 解決イベントの無視、classifier 連動の interrupted 遷移、stableContentId 限定の needs_page 回復、進行中保護つき選択的クリア、tombstone 付き prune/sweep。"'
```

---

