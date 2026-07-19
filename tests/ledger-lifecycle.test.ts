import { describe, it, expect } from "vitest";
import {
  emptyLedger, applyEnqueue, applyDownloadStarted, applyDownloadRequestFailed, applyReissueLease,
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

  it("requestFailed: pending -> error + terminalAt (CAS test)", () => {
    const { l, token } = enq();
    const started = applyDownloadStarted(l, "111:image:a", token, 1);
    const failed = applyDownloadRequestFailed(started, "111:image:a", token, "DOWNLOAD_FAILED", 15_000);
    expect(failed.jobs["111:image:a"].state).toBe("error");
    expect(failed.jobs["111:image:a"].error).toBe("DOWNLOAD_FAILED");
    expect(failed.jobs["111:image:a"].terminalAt).toBe(15_000);
    expect(failed.jobs["111:image:a"].leaseToken).toBeUndefined();
    const failed2 = applyDownloadRequestFailed(started, "111:image:a", "WRONG_TOKEN", "ERROR", 15_000);
    expect(failed2.jobs["111:image:a"]).toEqual(started.jobs["111:image:a"]);
  });
  it("reissueLease: oldToken match issues new token, mismatch returns record: null (CAS test)", () => {
    const { l, token } = enq();
    const newToken = mkTok();
    const r = applyReissueLease(l, "111:image:a", token, newToken, 12_000);
    expect(r.record).toBeDefined();
    expect(r.record!.state).toBe("pending");
    expect(r.record!.leaseToken).toBe(newToken);
    expect(r.record!.leasedAt).toBe(12_000);
    expect(r.record!.downloadId).toBeUndefined();
    const r2 = applyReissueLease(l, "111:image:a", "WRONG_TOKEN", mkTok(), 12_000);
    expect(r2.record).toBeNull();
    expect(r2.ledger).toEqual(l);
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
  it("same-mutation prune: ledger never exceeds cap (spec 7c-2)", () => {
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
    expect(done.jobs["k1"]).toBeUndefined();
    expect(done.jobs["111:image:a"].state).toBe("done");
  });
  it("clearTerminal は terminal のみ削除し、downloadId 付きの進行中(live DL)を残し、gen>0 は tombstone 化", () => {
    const { l, token } = enq();
    const done = applyDownloadComplete(applyDownloadStarted(l, "111:image:a", token, 1), "111:image:a", token, "/dl/fanbox/s/T/a.jpeg", 1);
    // 2 本目: downloadId 付きで進行中(browser 側に実体のある live DL なので孤児化を避けて残す必要がある)
    const enqueuedB = applyEnqueue(done, [{ ...cand(), idemKey: "111:image:b", stableContentId: "image:b", url: "https://downloads.fanbox.cc/images/post/111/b.jpeg", basePath: "fanbox/s/T/b.jpeg" }], baseOpts);
    const both = applyDownloadStarted(enqueuedB.ledger, "111:image:b", enqueuedB.toStart[0].leaseToken!, 7);
    const gen1: Ledger = { ...both, jobs: { ...both.jobs, "111:image:a": { ...both.jobs["111:image:a"], generation: 2 } } };
    const cleared = applyClearTerminal(gen1, 999_999);
    expect(cleared.jobs["111:image:a"]).toBeUndefined();
    expect(cleared.jobs["111:image:b"]).toBeDefined(); // downloadId 有りの進行中は残す
    expect(cleared.jobs["111:image:b"].state).toBe("requested");
    expect(cleared.generations["111:image:a"]).toBe(2); // tombstone
  });
  it("clearTerminal: 猶予期間(10s)を過ぎても downloadId 無しの pending(lease-only 残骸)は削除される (spec §7c-3 修正: stale nonterminal 復旧・必須テスト)", () => {
    const { l } = enq(); // pending + lease(leasedAt=10_000, downloadId 未永続 = browser 側に実体の無い lease-only 残骸)
    const cleared = applyClearTerminal(l, 25_000); // 経過 15s > 猶予 10s
    expect(cleared.jobs["111:image:a"]).toBeUndefined();
    expect(cleared.generations["111:image:a"]).toBeUndefined(); // gen 0 は tombstone 化しない
  });
  it("clearTerminal: 猶予期間内は downloadId 無しの pending でも削除しない (codex レビュー指摘: download() がキュー外の非同期空白から呼ばれる競合窓の保護)", () => {
    const { l } = enq(); // pending + lease(leasedAt=10_000)。download() 呼び出し自体はまだ解決していないだけかもしれない
    const cleared = applyClearTerminal(l, 15_000); // 経過 5s < 猶予 10s
    expect(cleared.jobs["111:image:a"]).toBeDefined();
    expect(cleared.jobs["111:image:a"].state).toBe("pending");
    expect(cleared.jobs["111:image:a"].leaseToken).toBeTruthy();
  });
  it("clearTerminal: downloadId 無しの pending は猶予期間経過後なら gen>0 でも削除され tombstone 化される", () => {
    const { l } = enq();
    const gen1: Ledger = { ...l, jobs: { ...l.jobs, "111:image:a": { ...l.jobs["111:image:a"], generation: 2 } } };
    const cleared = applyClearTerminal(gen1, 25_000);
    expect(cleared.jobs["111:image:a"]).toBeUndefined();
    expect(cleared.generations["111:image:a"]).toBe(2);
  });
  it("clearTerminal: downloadId 有りの requested(browser に実体のある live DL)は猶予期間経過後も削除されない (spec §7c-3 必須テスト)", () => {
    const { l, token } = enq();
    const started = applyDownloadStarted(l, "111:image:a", token, 1);
    const cleared = applyClearTerminal(started, 999_999);
    expect(cleared.jobs["111:image:a"]).toBeDefined();
    expect(cleared.jobs["111:image:a"].state).toBe("requested");
    expect(cleared.jobs["111:image:a"].downloadId).toBe(1);
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
    const swept = applyPruneSweep(l, 3_000_000, { maxTerminal: 2, maxAgeMs: YEAR, maxTombstones: 10 });
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
    let cleared = applyClearTerminal(gen2, 999_999);
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
