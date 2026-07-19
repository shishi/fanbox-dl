import { sanitizeSegment } from "../src/core/sanitizer";
const O = { replacement: "_", maxLen: 200 };

describe("sanitizeSegment", () => {
  it("禁止文字を置換する", () => {
    expect(sanitizeSegment('a/b\\c', O)).toBe("a_b_c");
    expect(sanitizeSegment('a:b*c?d"e<f>g|h', O)).toBe("a_b_c_d_e_f_g_h");
  });
  it("制御文字を置換する(通常スペースは保持)", () => {
    expect(sanitizeSegment("ab", O)).toBe("a_b");
    expect(sanitizeSegment("a b c", O)).toBe("a b c");
  });
  it("先頭と末尾のドット/空白を除去する", () => {
    expect(sanitizeSegment("  .name.  ", O)).toBe("name");
  });
  it("空になったらフォールバック名", () => {
    expect(sanitizeSegment("...", O)).toBe("untitled");
    expect(sanitizeSegment("", O)).toBe("untitled");
  });
  it("Windows 予約名を回避する(変換後に再チェック)", () => {
    expect(sanitizeSegment("CON", O)).toBe("CON_");
    expect(sanitizeSegment("con.txt", O)).toBe("con.txt_");
    expect(sanitizeSegment("LPT9", O)).toBe("LPT9_");
  });
  it("NFC 正規化する", () => {
    // か(U+304B) + 濁点(U+3099) -> NFC で が(U+304C)
    expect(sanitizeSegment("が", O)).toBe("が");
  });
  it("maxLen で切り詰める", () => {
    expect([...sanitizeSegment("a".repeat(300), O)]).toHaveLength(200);
  });
  it("preserveExt 時は拡張子を保持して base を切り詰める", () => {
    const r = sanitizeSegment("a".repeat(300) + ".png", { ...O, maxLen: 10, preserveExt: true });
    expect(r.endsWith(".png")).toBe(true);
    expect([...r].length).toBe(10);
  });
});