// spec §4a: parse 層由来のメディア URL は、あらゆるネットワーク使用の前に
// このホスト+パス形状 allowlist を通す(confused deputy 防止)。
const ALLOWED_HOST = "downloads.fanbox.cc";

export function validateMediaUrl(
  url: string,
  postId: string,
): { ok: true } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `URL として不正: ${url}` };
  }
  if (u.protocol !== "https:") return { ok: false, error: `https 以外: ${url}` };
  if (u.host !== ALLOWED_HOST) return { ok: false, error: `許可外ホスト: ${u.host}` };
  // URL パーサ通過後の pathname で判定(../ は正規化されるため postId 照合が本丸)
  const m = u.pathname.match(/^\/(images|files)\/post\/([^/]+)\/[^/]+$/);
  if (!m) return { ok: false, error: `許可外パス形状: ${u.pathname}` };
  if (m[2] !== postId) return { ok: false, error: `postId 不一致: ${m[2]} != ${postId}` };
  return { ok: true };
}
