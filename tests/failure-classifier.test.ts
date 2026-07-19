import { describe, it, expect } from "vitest";
import { classifyDownloadError } from "../src/background/failure-classifier";

describe("classifyDownloadError (spec §6)", () => {
  it("USER_* / FILE_* は terminal_error(ページを開いても直らない)", () => {
    expect(classifyDownloadError("USER_CANCELED")).toBe("terminal_error");
    expect(classifyDownloadError("FILE_NO_SPACE")).toBe("terminal_error");
    expect(classifyDownloadError("FILE_NAME_TOO_LONG")).toBe("terminal_error");
  });
  it("NETWORK_* は retry_once", () => {
    expect(classifyDownloadError("NETWORK_FAILED")).toBe("retry_once");
    expect(classifyDownloadError("NETWORK_TIMEOUT")).toBe("retry_once");
  });
  it("SERVER_FORBIDDEN (403) は初回から terminal_error (spec §7a 明示エラー)", () => {
    expect(classifyDownloadError("SERVER_FORBIDDEN")).toBe("terminal_error");
  });
  it("その他の SERVER_* は needs_page(URL 失効・編集の可能性)", () => {
    expect(classifyDownloadError("SERVER_BAD_CONTENT")).toBe("needs_page");
  });
  it("未知・undefined は安全側の terminal_error", () => {
    expect(classifyDownloadError(undefined)).toBe("terminal_error");
    expect(classifyDownloadError("CRASH")).toBe("terminal_error");
  });
});
