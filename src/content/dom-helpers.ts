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

// 投稿ヘッダーの「日付行」らしいテキストか。
// E2E 退行の root cause 対応: 投稿ページには投稿タイトル以外の h1(クリエイター
// ヘッダーのクリエイター名)が存在し、文書順で投稿タイトルより前に来る。
// 「最初の h1 = 投稿タイトル」という仮定は誤アンカーを生むため、h1 の隣の
// テキストが日付行かどうかで投稿ヘッダーを判別する。クラス名はハッシュ化される
// ので使えず、日付の表記はロケール依存("July 19th, 2026 12:00・All users" /
// "2026年7月19日 12:00・全体公開")のため、ロケールに依らない時刻パターン
// FANBOX の日付行の構造を条件にする: 日付は行の「先頭」にあり、年(20XX)→
// 時刻(H:MM)の順で現れる("July 19th, 2026 12:00・All users" /
// "2026年7月19日 12:00・全体公開")。可視性ラベルやプラン名は日付の後ろに付く
// 可変サフィックスなので判定に使わない。具体的には「先頭 40 文字以内に
// もっともらしい年(20XX)が時刻より前に出現する」ことを条件にする。
// codex-review 指摘の変遷:
// - 時刻のみ → 本文 "Starts 12:00 JST" に誤爆(round1 P2)
// - 任意の 4 桁を年扱い → 値段 "1000円プランは 12:00 開始" に誤爆(round2 P2)
// - 全長 80 文字上限 → 長いプラン名つきの本物のヘッダーを弾く(round2 P3)
// 先頭 40 文字だけを見ることで、サフィックスの長さに依存せず(P3 解消)、
// 20XX 限定で値段・ID の誤検出を避け(P2 解消)、年→時刻の順序制約で本文の
// 偶然の併記も除外する。なお呼び出し側(findPostButtonAnchor)は文書順の
// 先勝ちで選ぶため、本物のヘッダー(本文より前)が確実にマッチする限り、
// 本文側に万一の偽陽性が残っても勝つことはない。
export function isPostDateRowText(text: string): boolean {
  const head = text.trim().slice(0, 40);
  const yearIndex = head.search(/20\d{2}/);
  const time = /\d{1,2}:\d{2}/.exec(head);
  return yearIndex >= 0 && time !== null && yearIndex < time.index;
}

// h1 のテキストが「この投稿ページの投稿タイトル」かを document.title との
// 前方一致で判定する。投稿ページの document.title は
// 「<投稿タイトル>｜<クリエイター名>｜pixivFANBOX」形式(実測)のため、
// 先頭一致するのは投稿タイトル h1 だけで、クリエイター名 h1(文書順で先に
// 現れる)は途中一致にしかならない。
// codex-review 指摘(round3 P2): 日付行判別(isPostDateRowText)単体では、
// クリエイターヘッダー h1 の隣に年+時刻を含むテキスト(プロフィールの配信
// スケジュール等)が来た場合に誤爆する。テキストヒューリスティックをいくら
// 精緻化しても「どの h1 が投稿タイトルか」は決まらないため、この構造ガードを
// AND 条件で重ねる。SPA 遷移直後で document.title が未更新の間は不一致に
// なり得るが、その間は固定右下フォールバックに置かれ、タイトル更新後の
// 再計算(毎秒)で正位置へ自己修復する。
// codex-review 指摘(round4 P2): 単純な前方一致だと、投稿タイトルがクリエイター
// 名で始まる場合("POPYPOPY 夏コミ進捗…")にクリエイター名 h1 も通ってしまう。
// 一致直後が区切り(全角「｜」実測。round5 P2 対応で ASCII「|」・空白付きも許容)
// であることを要求し、第 1 セグメント(=投稿タイトル)全体との一致にする。
// 投稿タイトル自体に「｜」が含まれていても、h1 はタイトル全文を持つため区切り
// 位置はずれない。万一 FANBOX が別形式のタイトルを使う環境ではここが false に
// なり続けるが、その場合ボタンは可視の固定右下フォールバックに留まる
// (graceful degradation。不可視・誤配置にはならない)。
export function isPostTitleHeadingText(h1Text: string, docTitle: string): boolean {
  const t = h1Text.trim();
  if (t.length === 0 || !docTitle.startsWith(t)) return false;
  const rest = docTitle.slice(t.length).trimStart();
  return rest.startsWith("｜") || rest.startsWith("|");
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
