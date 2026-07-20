import { describe, it, expect } from "vitest";
import { postIdFromPathname, postIdFromHref, isCreatorPostListPage } from "../src/content/dom-helpers";

describe("postIdFromPathname", () => {
  it("サブドメイン形式 /posts/{id}", () => { expect(postIdFromPathname("/posts/12272980")).toBe("12272980"); });
  it("www 形式 /@creator/posts/{id}", () => { expect(postIdFromPathname("/@ropy/posts/12272980")).toBe("12272980"); });
  it("投稿ページ以外は null", () => {
    expect(postIdFromPathname("/")).toBeNull();
    expect(postIdFromPathname("/@ropy")).toBeNull();
  });
});

describe("postIdFromHref", () => {
  it("相対 / 絶対どちらの href からも postId を取る", () => {
    expect(postIdFromHref("/@ropy/posts/12272980")).toBe("12272980");
    expect(postIdFromHref("https://www.fanbox.cc/@ropy/posts/12272980")).toBe("12272980");
    expect(postIdFromHref("https://ropy.fanbox.cc/posts/12272980")).toBe("12272980");
  });
  it("投稿リンクでない href は null", () => {
    expect(postIdFromHref("/@ropy")).toBeNull();
    expect(postIdFromHref("https://www.fanbox.cc/@ropy/plans")).toBeNull();
  });
});

describe("isCreatorPostListPage", () => {
  it("www 形式(投稿一覧)は true", () => {
    expect(isCreatorPostListPage("/@ropy", "www.fanbox.cc")).toBe(true);
    expect(isCreatorPostListPage("/@ropy/posts", "www.fanbox.cc")).toBe(true);
  });
  it("クリエイターサブドメインの / または /posts(/) は true", () => {
    expect(isCreatorPostListPage("/", "ropy.fanbox.cc")).toBe(true);
    expect(isCreatorPostListPage("/posts", "ropy.fanbox.cc")).toBe(true);
    expect(isCreatorPostListPage("/posts/", "ropy.fanbox.cc")).toBe(true);
  });
  it("www のホーム(/)は false", () => {
    expect(isCreatorPostListPage("/", "www.fanbox.cc")).toBe(false);
  });
  it("投稿詳細はホストによらず false", () => {
    expect(isCreatorPostListPage("/@ropy/posts/12272980", "www.fanbox.cc")).toBe(false);
    expect(isCreatorPostListPage("/posts/12272980", "ropy.fanbox.cc")).toBe(false);
  });
  it("その他のパスは false", () => {
    expect(isCreatorPostListPage("/@ropy/plans", "www.fanbox.cc")).toBe(false);
  });
});
