import { describe, it, expect } from "vitest";
import { validateMediaUrl } from "../src/core/url-allowlist";

describe("validateMediaUrl", () => {
  const ok = (u: string, p = "111") => expect(validateMediaUrl(u, p).ok).toBe(true);
  const ng = (u: string, p = "111") => expect(validateMediaUrl(u, p).ok).toBe(false);

  it("images/files の正規 URL を許可", () => {
    ok("https://downloads.fanbox.cc/images/post/111/abc.jpeg");
    ok("https://downloads.fanbox.cc/files/post/111/abc.mp4");
  });
  it("ホスト違いを拒否(サブドメイン偽装含む)", () => {
    ng("https://evil.example.com/images/post/111/a.jpeg");
    ng("https://downloads.fanbox.cc.evil.example/images/post/111/a.jpeg");
    ng("https://api.fanbox.cc/images/post/111/a.jpeg");
  });
  it("http(非 https)を拒否", () => {
    ng("http://downloads.fanbox.cc/images/post/111/a.jpeg");
  });
  it("パス形状違いを拒否", () => {
    ng("https://downloads.fanbox.cc/other/post/111/a.jpeg");
    ng("https://downloads.fanbox.cc/images/post/111"); // ファイル名なし
  });
  it("postId 不一致を拒否 (confused deputy 防止)", () => {
    ng("https://downloads.fanbox.cc/images/post/222/a.jpeg", "111");
  });
  it("トラバーサル・URL でないものを拒否", () => {
    ng("https://downloads.fanbox.cc/images/post/111/../222/a.jpeg");
    ng("not a url");
  });
});
