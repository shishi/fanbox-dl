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
  it("クリエイターページ(投稿一覧)は true", () => {
    expect(isCreatorPostListPage("/@ropy")).toBe(true);
    expect(isCreatorPostListPage("/@ropy/posts")).toBe(true);
  });
  it("投稿詳細・その他は false", () => {
    expect(isCreatorPostListPage("/@ropy/posts/12272980")).toBe(false);
    expect(isCreatorPostListPage("/")).toBe(false);
    expect(isCreatorPostListPage("/@ropy/plans")).toBe(false);
  });
});
