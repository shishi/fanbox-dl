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
