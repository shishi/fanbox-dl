import { describe, it, expect } from "vitest";
import { mergeSettings, DEFAULT_SETTINGS, CONFLICT_ACTION } from "../src/core/settings";

describe("mergeSettings (fanbox)", () => {
  it("undefined なら既定値を返す", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it("部分指定は既定値にマージされる", () => {
    const s = mergeSettings({ pathTemplate: "x/$postId" });
    expect(s.pathTemplate).toBe("x/$postId");
    expect(s.zipGalleries).toBe(true);
  });
  it("contentTypes は deep merge", () => {
    const s = mergeSettings({ contentTypes: { photo: false } as any });
    expect(s.contentTypes).toEqual({ photo: false, file: true, video: true });
  });
  it("保存済みの conflictAction(旧値・不正値)は無視され、結果に含まれない (spec §14)", () => {
    const s = mergeSettings({ conflictAction: "overwrite" } as any);
    expect((s as any).conflictAction).toBeUndefined();
  });
  it("未知キーは持ち込まれない", () => {
    const s = mergeSettings({ evil: 1 } as any);
    expect((s as any).evil).toBeUndefined();
  });
  it("CONFLICT_ACTION 定数は uniquify", () => {
    expect(CONFLICT_ACTION).toBe("uniquify");
  });
  it("既定テンプレートが fanbox 用", () => {
    expect(DEFAULT_SETTINGS.pathTemplate).toBe("fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/[$seq{3}_]$filename.$ext");
    expect(DEFAULT_SETTINGS.zipPathTemplate).toBe("fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/images_$contentId.zip");
  });
});
