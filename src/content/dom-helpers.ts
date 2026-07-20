// content script のボタン配置に使う純粋関数(DOM 非依存・単体テスト対象)。
export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}

// href(相対 or 絶対)から投稿 postId を抽出。投稿リンクでなければ null。
// 絶対 URL の場合は fanbox.cc ホスト(www.fanbox.cc または *.fanbox.cc)のみ対象。
// 相対 URL(host 無し)は従来どおり許可。
export function postIdFromHref(href: string): string | null {
  try {
    const u = new URL(href, "https://www.fanbox.cc");
    // 絶対 URL で fanbox 以外のホストは対象外(外部リンク誤認防止)
    if (u.host !== "fanbox.cc" && !u.host.endsWith(".fanbox.cc")) return null;
    return postIdFromPathname(u.pathname);
  } catch {
    return null;
  }
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

// 最終レビュー3巡目 P3: 投稿一覧の 1 カードにサムネ・タイトルなど複数の
// `/posts/{id}` anchor が存在すると、anchor 単位でボタンを付けた場合に
// 同じ投稿へ複数ボタンが重複表示される。postId 単位で dedup する。
//
// codex-review 指摘(累積): dedup の判定材料を anchor 側の data-fbxdl マーカーに
// 頼る設計は、マーカーの置き場所をどう選んでも DOM の部分的な再レンダリングで
// 破綻し得る ―― 選んだ 1 anchor だけにマークすればそのマーカーだけが消えて
// 重複注入し、同じ postId の anchor 全部にマークすれば、逆に実際にボタンを
// 保持している anchor/host だけが消えてマーカーだけが別 anchor に生き残り、
// ボタン自体は無くなったのに「既にある」と誤判定して永久に再注入されなくなる。
// マーカー(anchor 側)と実体(ボタンの生存)が別の DOM ノードにある限りこの手の
// 乖離は避けられない。
//
// そのため、「既に postId にボタンがあるか」は anchor 側のマーカーではなく、
// 呼び出し側が実際に生きているボタン要素を数え上げた結果として渡す
// (alreadyInjectedPostIds)。呼び出しをまたぐ独立した状態は一切持たず、判定は
// 常に「その postId 用のボタンが今の DOM に実在するか」そのものと一致するため、
// マーカーと実体が分離する余地がない。
//
// codex-review 指摘: 実際の fanbox 投稿一覧では 1 投稿につき 2 つの
// `/posts/{id}` anchor が入れ子になっている(外側の CardPostItem__Wrapper の
// 親要素はカード横断の共有コンテナ、内側の PostCover__StyledLink の親要素は
// 個々のカード)。祖先 anchor は子孫 anchor より必ず先に querySelectorAll の
// 結果に現れる(DOM の入れ子構造上の不変則: 親の開始タグは子の開始タグより前)
// ため、「文書順で最初」を選ぶ実装は共有コンテナ側の外側 anchor を選んでしまい、
// ボタンが個々のカードではなく共有コンテナに積み上がる回帰を生んだ。
// 「文書順で最後」を選べば、入れ子関係にある anchor 同士では常により深い
// (より個々のカードに固有な可能性が高い)方を選べる。兄弟関係(入れ子でない)
// anchor 同士では選ぶ側による違いはない。
export function selectPostAnchorIndicesToInject(postIds: (string | null)[], alreadyInjectedPostIds: Set<string>): number[] {
  const lastIndexForId = new Map<string, number>();
  for (let i = 0; i < postIds.length; i++) {
    const id = postIds[i];
    if (!id || alreadyInjectedPostIds.has(id)) continue;
    lastIndexForId.set(id, i); // 後勝ち: 同じ postId が複数あれば文書順で最後を採用
  }
  return Array.from(lastIndexForId.values()).sort((a, b) => a - b);
}
