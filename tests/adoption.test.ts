import { describe, it, expect } from "vitest";
import { pathMatchesBoundary, findAdoptable, type DownloadItemLike } from "../src/background/adoption";

describe("pathMatchesBoundary", () => {
  it("Windows セパレータを正規化して suffix 一致", () => {
    expect(pathMatchesBoundary("C:\\dl\\fanbox\\a\\b.jpg", "fanbox/a/b.jpg")).toBe(true);
    expect(pathMatchesBoundary("/home/u/dl/fanbox/a/b.jpg", "fanbox/a/b.jpg")).toBe(true);
  });
  it("境界誤マッチを拒否 (foobar/baz.jpg vs bar/baz.jpg) (spec §7c-1)", () => {
    expect(pathMatchesBoundary("/dl/foobar/baz.jpg", "bar/baz.jpg")).toBe(false);
  });
  it("完全一致も許可", () => {
    expect(pathMatchesBoundary("fanbox/a/b.jpg", "fanbox/a/b.jpg")).toBe(true);
  });
});

describe("findAdoptable (spec §7c-1)", () => {
  const lease = { url: "https://downloads.fanbox.cc/images/post/1/x.jpg", relPath: "fanbox/a/x.jpg", leasedAt: 1000 };
  const item = (over: Partial<DownloadItemLike>): DownloadItemLike => ({
    id: 1, url: lease.url, filename: "/dl/fanbox/a/x.jpg",
    startTime: new Date(2000).toISOString(), ...over,
  });
  it("URL+パス+startTime>=leasedAt の 3 条件で adopt", () => {
    expect(findAdoptable([item({})], lease)?.id).toBe(1);
  });
  it("URL のみ一致(古い手動 DL 等)は拒否", () => {
    expect(findAdoptable([item({ filename: "/somewhere/else.jpg" })], lease)).toBeNull();
  });
  it("lease より前に始まった項目は拒否", () => {
    expect(findAdoptable([item({ startTime: new Date(500).toISOString() })], lease)).toBeNull();
  });
  it("候補が複数残ったら adopt 拒否(どれが自分の成果か決定できない)", () => {
    expect(findAdoptable([item({ id: 1 }), item({ id: 2 })], lease)).toBeNull();
  });
  it("候補ゼロも null(通常の再投入へ)", () => {
    expect(findAdoptable([], lease)).toBeNull();
  });
});
