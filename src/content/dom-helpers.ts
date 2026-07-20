// content script のボタン配置に使う純粋関数(DOM 非依存・単体テスト対象)。
export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}

// href(相対 or 絶対)から投稿 postId を抽出。投稿リンクでなければ null。
export function postIdFromHref(href: string): string | null {
  let path = href;
  try { path = new URL(href, "https://www.fanbox.cc").pathname; } catch { /* 相対のまま */ }
  return postIdFromPathname(path);
}

// クリエイター投稿一覧の面か。投稿詳細は false。true になるのは:
//  (a) www 形式 /@creator または /@creator/posts の末尾
//  (b) クリエイターサブドメイン(*.fanbox.cc、www は除く)の / または /posts
export function isCreatorPostListPage(pathname: string, host: string): boolean {
  if (postIdFromPathname(pathname)) return false; // /posts/{id} は詳細
  if (/^\/@[^/]+(?:\/posts)?\/?$/.test(pathname)) return true;
  const isCreatorSubdomain = /^[^.]+\.fanbox\.cc$/.test(host) && host !== "www.fanbox.cc";
  return isCreatorSubdomain && /^\/(?:posts\/?)?$/.test(pathname);
}
