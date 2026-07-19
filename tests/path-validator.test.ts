import { validatePath } from "../src/core/path-validator";
const O = { fullPathMaxLen: 180, uniquifyHeadroom: 16, conflictAction: "uniquify" as const, segmentMaxLen: 200 };

describe("validatePath", () => {
  it("正常な相対パスを通す", () => {
    expect(validatePath("fantia/c/foo.png", O).ok).toBe(true);
  });
  it("先頭スラッシュを拒否", () => {
    expect(validatePath("/abs/foo.png", O).ok).toBe(false);
  });
  it("ドライブレターを拒否", () => {
    expect(validatePath("C:/foo.png", O).ok).toBe(false);
  });
  it(".. を拒否", () => {
    expect(validatePath("a/../b.png", O).ok).toBe(false);
  });
  it(". と空セグメントを拒否", () => {
    expect(validatePath("a/./b.png", O).ok).toBe(false);
    expect(validatePath("a//b.png", O).ok).toBe(false);
  });
  it("uniquify 余白を差し引いた全体パス上限で判定", () => {
    const p = "a/" + "x".repeat(170) + ".png"; // 176 cp
    // 180 - 16 = 164 が実効上限 -> 176 は超過
    expect(validatePath(p, O).ok).toBe(false);
    // overwrite なら余白ゼロ -> 176 <= 180 で通る
    expect(validatePath(p, { ...O, conflictAction: "overwrite" }).ok).toBe(true);
  });
  it("uniquify 余白を差し引いた filename セグメント上限で判定", () => {
    const O2 = { fullPathMaxLen: 1000, uniquifyHeadroom: 16, conflictAction: "uniquify" as const, segmentMaxLen: 50 };
    const p = "a/" + "y".repeat(40) + ".png"; // last seg 44 cp
    // seg 実効 50-16=34 -> 44 超過
    expect(validatePath(p, O2).ok).toBe(false);
    // overwrite なら 44 <= 50 で通る
    expect(validatePath(p, { ...O2, conflictAction: "overwrite" }).ok).toBe(true);
  });
});
