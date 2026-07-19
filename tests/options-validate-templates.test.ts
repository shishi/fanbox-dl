import { describe, it, expect } from "vitest";
import { checkTemplate, hasTemplateError, hasBlockingTemplateError, type TemplateCheckInput } from "../src/options/validate-templates";
import type { RenderContext } from "../src/core/types";

const ctx: RenderContext = {
  creator: "c", creatorId: "1", postTitle: "t", postId: "1",
  postedAt: new Date("2026-01-01T00:00:00+09:00"), now: new Date(),
  contentTitle: "", contentId: "1", contentType: "photo", plan: "0",
  filename: "image", ext: "png", seq: 1, total: 1,
};
const base: Omit<TemplateCheckInput, "tpl"> = {
  ctx, replacement: "_", segmentMaxLen: 200, fullPathMaxLen: 180, uniquifyHeadroom: 16, conflictAction: "uniquify",
};

describe("checkTemplate / hasTemplateError (options save ガードの純粋ロジック / 最終レビュー修正3)", () => {
  it("正常なテンプレはエラーなし", () => {
    const r = checkTemplate({ ...base, tpl: "$creatorId/$filename.$ext" });
    expect(r.error).toBe("");
    expect(r.rel).not.toBe("");
  });

  it("未定義プレースホルダはテンプレートエラーになる", () => {
    const r = checkTemplate({ ...base, tpl: "$doesNotExist/$filename.$ext" });
    expect(r.error).toContain("テンプレートエラー");
  });

  it("実効上限を超えるパスは検証エラーになる(テンプレートエラーとは区別される)", () => {
    const r = checkTemplate({ ...base, tpl: "$creatorId/$filename.$ext", fullPathMaxLen: 3, uniquifyHeadroom: 0 });
    expect(r.error).toContain("検証エラー");
  });

  it("hasTemplateError は複数テンプレのうち1つでもエラーがあれば true", () => {
    const ok: TemplateCheckInput = { ...base, tpl: "$creatorId/$filename.$ext" };
    const bad: TemplateCheckInput = { ...base, tpl: "$doesNotExist" };
    expect(hasTemplateError([ok, ok])).toBe(false);
    expect(hasTemplateError([ok, bad])).toBe(true);
  });

  describe("hasBlockingTemplateError (zip 未使用時は zip テンプレのエラーで保存をブロックしない / codex レビュー指摘 P2 round3)", () => {
    const ok: TemplateCheckInput = { ...base, tpl: "$creatorId/$filename.$ext" };
    const bad: TemplateCheckInput = { ...base, tpl: "$doesNotExist" };

    it("メインテンプレのエラーは zip モードに関係なく常にブロックする", () => {
      expect(hasBlockingTemplateError(bad, { zipModeActive: false, zipPath: ok, zipEntry: ok })).toBe(true);
    });

    it("zip モード無効時は zip テンプレのエラーをブロックに数えない(未使用設定を直せなくなる regression 防止)", () => {
      expect(hasBlockingTemplateError(ok, { zipModeActive: false, zipPath: bad, zipEntry: bad })).toBe(false);
    });

    it("zip モード有効時は zip テンプレのエラーもブロックする", () => {
      expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: bad, zipEntry: ok })).toBe(true);
      expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: ok, zipEntry: bad })).toBe(true);
    });

    it("すべて正常ならブロックしない", () => {
      expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: ok, zipEntry: ok })).toBe(false);
    });
  });
});
