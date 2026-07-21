import { describe, it, expect } from "vitest";
import { postIdFromPathname, postIdFromHref, isCreatorPostListPage, selectPostAnchorIndicesToInject, isPostDateRowText, isPostTitleHeadingText, shouldHandleDlClick } from "../src/content/dom-helpers";

describe("isPostTitleHeadingText(codex-review round3 P2: 日付行判別だけではクリエイターヘッダー h1 の隣の年+時刻テキストに誤爆し得るため、document.title の前方一致で投稿タイトル h1 を構造的に特定する)", () => {
  const docTitle = "メイちゃんのえちち動画(short_ver)｜POPYPOPY｜pixivFANBOX";
  it("投稿タイトル h1(document.title の先頭に一致)は true", () => {
    expect(isPostTitleHeadingText("メイちゃんのえちち動画(short_ver)", docTitle)).toBe(true);
  });
  it("クリエイター名 h1(document.title の途中に出現)は false", () => {
    expect(isPostTitleHeadingText("POPYPOPY", docTitle)).toBe(false);
  });
  it("空テキストは false(空文字は任意の文字列の prefix になるため明示的に弾く)", () => {
    expect(isPostTitleHeadingText("", docTitle)).toBe(false);
    expect(isPostTitleHeadingText("   ", docTitle)).toBe(false);
  });
  it("前後の空白は無視して比較する", () => {
    expect(isPostTitleHeadingText("  メイちゃんのえちち動画(short_ver)  ", docTitle)).toBe(true);
  });
  it("投稿タイトルがクリエイター名で始まる場合、クリエイター名 h1 は false(codex-review round4 P2: 単純 prefix だと通ってしまう)", () => {
    const t = "POPYPOPY 夏コミ進捗まとめ｜POPYPOPY｜pixivFANBOX";
    expect(isPostTitleHeadingText("POPYPOPY", t)).toBe(false);
    expect(isPostTitleHeadingText("POPYPOPY 夏コミ進捗まとめ", t)).toBe(true);
  });
  it("投稿タイトル自体に区切り文字 ｜ が含まれていても全文一致なら true", () => {
    const t = "前編｜後編セット｜POPYPOPY｜pixivFANBOX";
    expect(isPostTitleHeadingText("前編｜後編セット", t)).toBe(true);
  });
  it("ASCII パイプや空白付き区切りでも動く(codex-review round5 P2: 区切りのハードコード回避)", () => {
    expect(isPostTitleHeadingText("タイトル", "タイトル | POPYPOPY | pixivFANBOX")).toBe(true);
    expect(isPostTitleHeadingText("タイトル", "タイトル|POPYPOPY|pixivFANBOX")).toBe(true);
  });
});

describe("isPostDateRowText(投稿ヘッダーの日付行の判別。E2E 退行の root cause: 最初の h1 を投稿タイトルとみなすとクリエイター名 h1 を誤って掴む)", () => {
  it("英語ロケールの日付行(実測値)は true", () => {
    expect(isPostDateRowText("July 19th, 2026 12:00・All users")).toBe(true);
  });
  it("日本語ロケールの日付行は true", () => {
    expect(isPostDateRowText("2026年7月19日 12:00・全体公開")).toBe(true);
  });
  it("クリエイターヘッダー h1 の隣に来るテキスト(実測値)は false", () => {
    expect(isPostDateRowText("")).toBe(false); // SNS アイコン列(テキスト無し)
    expect(isPostDateRowText("3D")).toBe(false); // カテゴリ
  });
  it("時刻を含んでいても長文(本文など)は false", () => {
    expect(isPostDateRowText("今日は 12:00 に起きて" + "長い本文".repeat(20))).toBe(false);
  });
  it("時刻パターンを含まない短文は false", () => {
    expect(isPostDateRowText("POPYPOPY")).toBe(false);
  });
  it("時刻はあるが年が無い本文短文は false(codex-review P2: 本文見出し直後の誤爆防止)", () => {
    expect(isPostDateRowText("Starts 12:00 JST")).toBe(false);
    expect(isPostDateRowText("12:00 から配信します")).toBe(false);
  });
  it("年はあるが時刻が無い短文は false", () => {
    expect(isPostDateRowText("2026 年もよろしく")).toBe(false);
  });
  it("値段など 20XX でない 4 桁数字は年とみなさない(codex-review round2 P2)", () => {
    expect(isPostDateRowText("1000円プランは 12:00 開始")).toBe(false);
  });
  it("長いプラン名サフィックスつきの本物の日付行は true(codex-review round2 P3: 長さ上限で本物を弾かない)", () => {
    expect(isPostDateRowText("July 19th, 2026 12:00・" + "とっても長いクリエイター定義のサポータープラン名".repeat(4))).toBe(true);
  });
  it("時刻が年より先に来るテキストは false(日付行は年→時刻の順)", () => {
    expect(isPostDateRowText("12:00 開始、2026年になりました")).toBe(false);
  });
});

describe("postIdFromPathname", () => {
  it("サブドメイン形式 /posts/{id}", () => { expect(postIdFromPathname("/posts/12272980")).toBe("12272980"); });
  it("www 形式 /@creator/posts/{id}", () => { expect(postIdFromPathname("/@ropy/posts/12272980")).toBe("12272980"); });
  it("投稿ページ以外は null", () => {
    expect(postIdFromPathname("/")).toBeNull();
    expect(postIdFromPathname("/@ropy")).toBeNull();
  });
});

describe("postIdFromHref", () => {
  it("相対 / 絶対どちらの href からも postId を取る", () => {
    expect(postIdFromHref("/@ropy/posts/12272980")).toBe("12272980");
    expect(postIdFromHref("https://www.fanbox.cc/@ropy/posts/12272980")).toBe("12272980");
    expect(postIdFromHref("https://ropy.fanbox.cc/posts/12272980")).toBe("12272980");
  });
  it("投稿リンクでない href は null", () => {
    expect(postIdFromHref("/@ropy")).toBeNull();
    expect(postIdFromHref("https://www.fanbox.cc/@ropy/plans")).toBeNull();
  });
  it("外部ホストの /posts/{id} は null を返す(一覧ページの外部リンク誤認防止)", () => {
    expect(postIdFromHref("https://example.com/posts/123")).toBeNull();
    expect(postIdFromHref("https://twitter.com/posts/456")).toBeNull();
  });
  it("fanbox.cc サブドメイン(例: ropy.fanbox.cc)の /posts/{id} は取得できる", () => {
    expect(postIdFromHref("https://ropy.fanbox.cc/posts/12272980")).toBe("12272980");
  });
  it("相対 URL /@creator/posts/{id} は従来どおり取得できる", () => {
    expect(postIdFromHref("/@ropy/posts/12272980")).toBe("12272980");
  });
});

describe("isCreatorPostListPage", () => {
  it("www 形式(投稿一覧)は true", () => {
    expect(isCreatorPostListPage("/@ropy", "www.fanbox.cc")).toBe(true);
    expect(isCreatorPostListPage("/@ropy/posts", "www.fanbox.cc")).toBe(true);
  });
  it("クリエイターサブドメインの / または /posts(/) は true", () => {
    expect(isCreatorPostListPage("/", "ropy.fanbox.cc")).toBe(true);
    expect(isCreatorPostListPage("/posts", "ropy.fanbox.cc")).toBe(true);
    expect(isCreatorPostListPage("/posts/", "ropy.fanbox.cc")).toBe(true);
  });
  it("www のホーム(/)は false", () => {
    expect(isCreatorPostListPage("/", "www.fanbox.cc")).toBe(false);
  });
  it("投稿詳細はホストによらず false", () => {
    expect(isCreatorPostListPage("/@ropy/posts/12272980", "www.fanbox.cc")).toBe(false);
    expect(isCreatorPostListPage("/posts/12272980", "ropy.fanbox.cc")).toBe(false);
  });
  it("その他のパスは false", () => {
    expect(isCreatorPostListPage("/@ropy/plans", "www.fanbox.cc")).toBe(false);
  });
});

describe("selectPostAnchorIndicesToInject(最終レビュー3巡目 P3: 1 カード複数リンクのボタン重複を postId 単位で dedup、かつ毎回の DOM スナップショットから純粋に計算し永続 Set を持たない)", () => {
  // codex-review 指摘(累積): 当初 anchor の data-fbxdl マーカーで「既にボタンが
  // あるか」を判定していたが、(a) 選ばれた 1 anchor だけにマークすると、DOM が
  // 部分的に差し替わってそのマーカーだけ消えた場合に dedup を見失い重複注入し、
  // (b) 逆に同じ postId の anchor 全部にマークすると、実際にボタンを保持している
  // 側の anchor/host だけが差し替わってマーカーだけが別 anchor に生き残った場合、
  // ボタン自体は消えたのに「既にある」と誤判定して永久に再注入されない。
  // マーカーと実体(ボタンの生存)が別の DOM ノードにある限りこの手の乖離は
  // 避けられないため、「既に postId にボタンがあるか」は呼び出し側が実際に生きて
  // いるボタン要素を数え上げた結果(alreadyInjectedPostIds という Set)として渡す
  // 契約にする。これなら判定の正誤は「ボタンの DOM 上の実在」に一致し、
  // 独立した状態を持たない。
  it("同一 postId の複数 anchor(サムネ+タイトル)はどちらもまだボタン未付与なら 1 件だけを選ぶ(文書順で最後に現れるもの)", () => {
    // codex-review 指摘: 実際の fanbox 投稿一覧では 1 投稿につき 2 つの
    // `/posts/{id}` anchor が入れ子になっている ―― 外側の CardPostItem__Wrapper
    // (親要素はカード横断の共有コンテナ)と、その内側の PostCover__StyledLink
    // (親要素は個々のカード)。祖先 anchor は子孫 anchor より必ず先に
    // querySelectorAll の結果に現れる(DOM の入れ子構造上の不変則)ため、
    // 「文書順で最初」を選ぶと共有コンテナ側の外側 anchor を選んでしまい、
    // ボタンがカードではなく共有コンテナに積み上がる回帰があった。
    // 「文書順で最後」を選べば、入れ子関係にある場合は常により深い(より
    // カード固有の可能性が高い)anchor を選べる。
    const postIds = ["1", "1", "2"];
    const picked = selectPostAnchorIndicesToInject(postIds, new Set());
    expect(picked).toEqual([1, 2]);
  });

  it("実際の fanbox 投稿一覧の構造(外側 wrapper anchor → 内側 cover anchor の入れ子)を模した場合、内側の anchor を選ぶ", () => {
    // index 0: 外側 CardPostItem__Wrapper(親 = カード横断の共有コンテナ)
    // index 1: 内側 PostCover__StyledLink(親 = 個々のカード) ← こちらを選びたい
    const postIds = ["12272980", "12272980"];
    const picked = selectPostAnchorIndicesToInject(postIds, new Set());
    expect(picked).toEqual([1]);
  });

  it("postId を抽出できない(null の)anchor は無視する", () => {
    const postIds = [null, "1"];
    const picked = selectPostAnchorIndicesToInject(postIds, new Set());
    expect(picked).toEqual([1]);
  });

  it("既にボタンが存在する postId には、新しい(未付与の)anchor が複数現れても何も選ばない", () => {
    const postIds = ["1", "1"];
    const picked = selectPostAnchorIndicesToInject(postIds, new Set(["1"]));
    expect(picked).toEqual([]);
  });

  it("ボタンを保持していた anchor/host が消え、実体のボタンも一緒に消えた場合は再注入する(alreadyInjectedPostIds は実在するボタンだけを反映するため、マーカーの残骸に引きずられない)", () => {
    const postIds = ["1"]; // 旧 anchor(とそのボタン)は既に DOM から消えている
    const picked = selectPostAnchorIndicesToInject(postIds, new Set()); // 呼び出し側が実在ボタン 0 件と数えた
    expect(picked).toEqual([0]);
  });
});

describe("shouldHandleDlClick(信頼クリックゲート: ページスクリプトが button.click() を合成すると、拡張の権限(cookie 付き post.info fetch + chrome.downloads)を無断駆動でき、dedup 無しの fire-and-forget 設計では無制限の重複 DL に直結する)", () => {
  it("実ユーザー操作のクリック(isTrusted: true)は処理する", () => {
    expect(shouldHandleDlClick({ isTrusted: true })).toBe(true);
  });
  it("スクリプトが合成したクリック(isTrusted: false。dispatchEvent / element.click() いずれも)は無視する", () => {
    expect(shouldHandleDlClick({ isTrusted: false })).toBe(false);
  });
});
