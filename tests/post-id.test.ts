import { describe, it, expect } from "vitest";
import { postIdFromPathname } from "../src/content/messages";

describe("postIdFromPathname", () => {
  it("サブドメイン形式 /posts/{id}", () => {
    expect(postIdFromPathname("/posts/12272980")).toBe("12272980");
  });
  it("www 形式 /@creator/posts/{id}", () => {
    expect(postIdFromPathname("/@ropy/posts/12272980")).toBe("12272980");
  });
  it("投稿ページ以外は null", () => {
    expect(postIdFromPathname("/")).toBeNull();
    expect(postIdFromPathname("/@ropy")).toBeNull();
    expect(postIdFromPathname("/posts")).toBeNull();
  });
});
