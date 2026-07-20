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

// クリエイター投稿一覧の面か(/@creator または /@creator/posts の末尾)。投稿詳細は false。
export function isCreatorPostListPage(pathname: string): boolean {
  if (postIdFromPathname(pathname)) return false; // /posts/{id} は詳細
  return /^\/@[^/]+(?:\/posts)?\/?$/.test(pathname);
}
