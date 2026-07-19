import { DEFAULT_SETTINGS, mergeSettings } from "../src/core/settings";

describe("mergeSettings", () => {
  it("undefined なら既定値", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it("部分上書きをマージする", () => {
    const m = mergeSettings({ pathTemplate: "x/$filename.$ext" });
    expect(m.pathTemplate).toBe("x/$filename.$ext");
    expect(m.conflictAction).toBe("uniquify");
  });
  it("contentTypes をネストマージする", () => {
    const m = mergeSettings({ contentTypes: { photo: false } as any });
    expect(m.contentTypes.photo).toBe(false);
    expect(m.contentTypes.file).toBe(true);
  });
  it("既定テンプレは連番オプショナルグループを含む", () => {
    expect(DEFAULT_SETTINGS.pathTemplate).toContain("[$seq{3}_]");
  });
  it("既定は zip モード ON", () => {
    expect(DEFAULT_SETTINGS.zipGalleries).toBe(true);
    expect(DEFAULT_SETTINGS.zipPathTemplate).toContain(".zip");
  });
});
