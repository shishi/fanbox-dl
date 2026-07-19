import { renderTemplate, TemplateError } from "../src/core/template-engine";
import type { RenderContext } from "../src/core/types";

const base: RenderContext = {
  creator: "sample_creator", creatorId: "1234",
  postTitle: "テスト投稿", postId: "1234567",
  postedAt: new Date("2026-01-15T12:30:00+09:00"),
  now: new Date("2026-07-10T12:00:00+09:00"),
  contentTitle: "ギャラリー", contentId: "42", contentType: "photo", plan: "無料プラン",
  filename: "foo", ext: "png", seq: 1, total: 4,
};
const O = { replacement: "_", segmentMaxLen: 200 };

describe("renderTemplate", () => {
  it("基本プレースホルダを展開する", () => {
    expect(renderTemplate("$creator/$postId/$filename.$ext", base, O))
      .toBe("sample_creator/1234567/foo.png");
  });
  it("$date{FMT} を投稿日で展開する", () => {
    expect(renderTemplate("$date{YYYYMMDD}", base, O)).toBe("20260115");
    expect(renderTemplate("$date{YYYY-MM-DD}", base, O)).toBe("2026-01-15");
  });
  it("$today{FMT} を実行日で展開する", () => {
    expect(renderTemplate("$today{YYYYMMDD}", base, O)).toBe("20260710");
  });
  it("$seq{N} をゼロ詰めする(複数時)", () => {
    expect(renderTemplate("$seq{3}", base, O)).toBe("001");
  });
  it("$seq は total<=1 のとき空文字", () => {
    expect(renderTemplate("x$seqy", { ...base, total: 1 }, O)).toBe("xy");
  });
  it("オプショナルグループ: seq 複数なら付与、単一なら丸ごと消える", () => {
    const t = "[$seq{3}_]$filename.$ext";
    expect(renderTemplate(t, base, O)).toBe("001_foo.png");
    expect(renderTemplate(t, { ...base, total: 1 }, O)).toBe("foo.png");
  });
  it("オプショナルグループ: 空プレースホルダで消える", () => {
    expect(renderTemplate("a[/$contentTitle]b", { ...base, contentTitle: "" }, O)).toBe("ab");
    expect(renderTemplate("a[/$contentTitle]b", base, O)).toBe("a/ギャラリーb");
  });
  it("$plan を展開する", () => {
    expect(renderTemplate("$plan", base, O)).toBe("無料プラン");
  });
  it("セグメントを sanitize する(禁止文字)", () => {
    expect(renderTemplate("$postTitle", { ...base, postTitle: 'a:b' }, O)).toBe("a_b");
  });
  it("ネストしたオプショナルグループも内部の空で消える", () => {
    expect(renderTemplate("x[a[$seq]_b]y", { ...base, total: 1 }, O)).toBe("xy");
    expect(renderTemplate("x[a[$seq{2}]_b]y", base, O)).toBe("xa01_by");
  });
  it("未知プレースホルダは TemplateError", () => {
    expect(() => renderTemplate("$nope", base, O)).toThrow(TemplateError);
  });
});
