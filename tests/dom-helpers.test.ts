import { describe, it, expect } from "vitest";
import { postIdFromPathname, postIdFromHref, isCreatorPostListPage, selectPostAnchorIndicesToInject } from "../src/content/dom-helpers";

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
