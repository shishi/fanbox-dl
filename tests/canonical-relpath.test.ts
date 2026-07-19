import { describe, it, expect } from "vitest";
import { canonicalRelPath } from "../src/core/canonical-relpath";

describe("canonicalRelPath", () => {
  it("generation 0 は basePath をそのまま返す", () => {
    expect(canonicalRelPath("a/b/c.jpg", 0)).toBe("a/b/c.jpg");
  });
  it("generation > 0 は最終セグメントの拡張子直前に .rev{N}", () => {
    expect(canonicalRelPath("a/b/c.jpg", 1)).toBe("a/b/c.rev1.jpg");
    expect(canonicalRelPath("a/b/c.jpg", 12)).toBe("a/b/c.rev12.jpg");
  });
  it("拡張子なしの最終セグメントは末尾に .rev{N}", () => {
    expect(canonicalRelPath("a/b/noext", 2)).toBe("a/b/noext.rev2");
  });
  it("ディレクトリ名のドットに惑わされない(最終セグメントだけ見る)", () => {
    expect(canonicalRelPath("v1.0/c.jpg", 1)).toBe("v1.0/c.rev1.jpg");
  });
  it("同じ入力は常に同じ出力(決定性)", () => {
    expect(canonicalRelPath("x/y.png", 3)).toBe(canonicalRelPath("x/y.png", 3));
  });
});
