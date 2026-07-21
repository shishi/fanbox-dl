import { fetchPostInfo } from "../fanbox/api";
import { postIdFromPathname, postIdFromHref, isCreatorPostListPage, selectPostAnchorIndicesToInject, isPostDateRowText, isPostTitleHeadingText, shouldHandleDlClick } from "./dom-helpers";
import type { DownloadRequestMessage, DownloadResponse } from "./messages";

// 指定 postId の投稿を DL(content script が isolated world で post.info を fetch → SW へ)。
async function runDownloadFor(postId: string): Promise<DownloadResponse | null> {
  const fetched = await fetchPostInfo(postId);
  if (!fetched.ok) { alert(`[fanbox-dl] 取得失敗: ${fetched.error}`); return null; }
  const res = (await chrome.runtime.sendMessage({ kind: "download", postId, json: fetched.json } satisfies DownloadRequestMessage)) as DownloadResponse | undefined;
  if (!res) { alert("[fanbox-dl] background から応答がありません"); return null; }
  if (res.errors.length) alert(`[fanbox-dl] エラー: ${res.errors.join(" / ")}`);
  if (res.notices.length) alert(`[fanbox-dl] お知らせ:\n${res.notices.join("\n")}`);
  return res;
}

function styleBtn(b: HTMLButtonElement, small = false) {
  if (small) {
    // カード上に重なる小ボタン: 明るいサムネでも暗いサムネでも視認できるよう
    // 濃い半透明背景 + 白文字 + 影でコントラストを確保する(白背景だと明るい
    // サムネに埋没して気づかれない ── 実 FANBOX での見落とし報告に対応)。
    Object.assign(b.style, {
      padding: "4px 10px", borderRadius: "6px", cursor: "pointer",
      fontSize: "14px", fontWeight: "700", border: "1px solid rgba(255,255,255,.65)",
      background: "rgba(0,0,0,.72)", color: "#fff", lineHeight: "1.4",
      boxShadow: "0 1px 5px rgba(0,0,0,.5)",
    });
  } else {
    Object.assign(b.style, {
      padding: "6px 12px", borderRadius: "6px", cursor: "pointer",
      fontSize: "14px", border: "1px solid rgba(0,0,0,.2)",
      background: "#fff", color: "#222", lineHeight: "1.4",
    });
  }
}
function swapText(b: HTMLButtonElement, temp: string, ms = 2500) {
  const orig = b.dataset.origText ?? b.textContent ?? "";
  if (!b.dataset.origText) b.dataset.origText = orig;
  b.textContent = temp;
  setTimeout(() => { b.textContent = b.dataset.origText || orig; b.disabled = false; }, ms);
}
function makeDlButton(label: string, small: boolean, onClick: () => Promise<DownloadResponse | null>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; b.title = "この投稿をダウンロード";
  styleBtn(b, small);
  b.addEventListener("click", (ev) => {
    // 信頼クリックゲート: 合成クリックで拡張の権限を無断駆動させない
    // (判定の意図と経緯は shouldHandleDlClick 定義側のコメント参照)。
    if (!shouldHandleDlClick(ev)) return;
    ev.preventDefault(); ev.stopPropagation();
    b.disabled = true;
    onClick().then((r) => { if (r) swapText(b, `⬇ ${r.queued + r.zipQueued} 件開始`); else b.disabled = false; })
      .catch(() => { b.disabled = false; });
  });
  return b;
}

// --- 投稿ページ: 日付ヘッダーの下(fallback 固定右下) ---
const POST_CONTAINER_ID = "fbxdl-post-btn";
// 投稿ページボタンの挿入基準要素を決める。shishi 要望で「日付の下」に置く。
// 投稿ヘッダーは <div PostHead><h1 PostTitle>…</h1><div PostHeadBottom>日付…</div></div>
// の構造で、日付は h1 の「次の兄弟要素」。クラス名はハッシュ化される(styled__…-sc-…)
// ため狙い撃ちできない。
//
// E2E 退行の root cause: 投稿ページには投稿タイトル以外の h1(クリエイター
// ヘッダーのクリエイター名。実測でログアウト表示ですら h1 が 3 つあり、
// クリエイター名 h1 が文書順で先)が存在するため、「最初の h1 = 投稿タイトル」
// という仮定ではクリエイターヘッダーへ誤アンカーする(実 E2E でボタンが
// CreatorHeader__Column 内に刺さり 0×0 に潰れて不可視になった)。
// そこで h1 を文書順に全走査し、次の 2 条件を両方満たす最初の h1 の日付行を
// 採用する(どちらか単独では codex-review で反例が出た二重ガード):
//  (1) h1 テキストが document.title の先頭に一致(isPostTitleHeadingText:
//      投稿タイトル h1 の構造的特定。クリエイター名 h1・本文 h1 を排除)
//  (2) 次の兄弟(自ボタンはスキップ)が日付行らしいテキスト(isPostDateRowText:
//      先頭 40 文字以内で年 20XX →時刻 H:MM の順、ロケール耐性)
// 見つからない間(描画途中・変種レイアウト)は null を返し、呼び出し側の
// 固定右下フォールバックに任せる。codex-review 指摘(round1 P2): 「最後の h1」
// 等の h1 ベース暫定アンカーは、本文中のユーザー作成 h1(記事型投稿の見出し
// ブロック)へ誤アンカーし得るため持たない。誤った場所に刺さるより、確実に
// 見える固定位置で日付行の出現を待つ方が安全(ステートレス再アンカーにより
// 出現後 1 秒以内に正位置へ自己修復する)。
function findPostButtonAnchor(): HTMLElement | null {
  for (const h of Array.from(document.querySelectorAll<HTMLElement>("h1"))) {
    if (!h.parentElement) continue;
    if (!isPostTitleHeadingText(h.textContent ?? "", document.title)) continue;
    let next = h.nextElementSibling;
    while (next && next.id === POST_CONTAINER_ID) next = next.nextElementSibling; // 自ボタンは日付候補から除外
    if (next instanceof HTMLElement && isPostDateRowText(next.textContent ?? "")) return next;
  }
  return null;
}
// 「アンカー基準の正規位置」に置いた状態のスタイル(日付ヘッダーの直下に、独立した
// 行として少し間隔を空けて表示)。fallback から復帰するときも同じ値へ揃える。
function styleAnchoredPostButton(b: HTMLElement) {
  Object.assign(b.style, {
    position: "", right: "", bottom: "", zIndex: "",
    marginLeft: "0", marginTop: "10px", display: "inline-block",
  });
}
// 最終レビュー修正 P1a: 投稿ページボタンの click は、生成時にクロージャで
// 握った postId ではなく、クリック時点の location.pathname から都度読む。
// post→post の SPA 遷移では既存ボタンが再利用され続ける(早期 return)ため、
// クロージャの postId を握ったままだと旧投稿がずっと DL されてしまう。
// カードボタン(injectListButtons)は各カード固有の postId を握ったままで正しいので対象外。
function placePostButton() {
  const existing = document.getElementById(POST_CONTAINER_ID);
  const anchor = findPostButtonAnchor();
  // 最終レビュー修正 P3(round5)+ codex-review P2 + E2E 退行対応:
  // 「一度置いたら終わり」の終端状態を持たない。毎回「今の DOM での最良
  // アンカー」を再計算し、ボタンがその直後に居なければ移動する。
  // 終端状態(旧 "anchored" / "date")方式は、描画途中の誤アンカー
  // (クリエイター名 h1 への誤配置など)が確定してしまい自己修復できない
  // ことが実 E2E で判明したため廃止した。再計算は決定的(同じ DOM なら同じ
  // 結果)なので、正しく置けていれば下の直後判定で即 return する=冪等。
  // アンカーが見つからない間は現位置(fallback 含む)を維持する。
  if (existing) {
    if (!anchor || existing.previousElementSibling === anchor) return;
    // codex-review 指摘(round5 P2): ここで既存ボタンを remove() して新規に
    // 作り直すと、ユーザーが既にクリック済みで runDownloadFor() が in-flight
    // (b.disabled = true 済み、テキストも変更済み)の場合にその状態が失われ、
    // 生まれ変わった新ボタンは disabled=false の初期状態になる。ユーザーが
    // 再クリックできてしまい、同じ投稿が二重にダウンロードされ得る。
    // そのため作り直さず、既存の DOM ノードをそのまま(disabled 状態や
    // イベントリスナーを保ったまま)本来の位置へ移動するだけにする。
    styleAnchoredPostButton(existing);
    anchor.insertAdjacentElement("afterend", existing);
    existing.dataset.fbxdlPlacement = "date";
    return;
  }
  const btn = makeDlButton("⬇ fanbox-dl", false, () => {
    const currentPostId = postIdFromPathname(location.pathname);
    return currentPostId ? runDownloadFor(currentPostId) : Promise.resolve(null);
  });
  btn.id = POST_CONTAINER_ID;
  if (anchor) {
    styleAnchoredPostButton(btn);
    anchor.insertAdjacentElement("afterend", btn);
    btn.dataset.fbxdlPlacement = "date";
  } else {
    // フォールバック: 固定右下(必ず出る)
    Object.assign(btn.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "99999" });
    document.body.appendChild(btn);
    btn.dataset.fbxdlPlacement = "fallback";
  }
}
function whenReady(cb: () => void, timeoutMs = 6000) {
  cb();
  if (document.getElementById(POST_CONTAINER_ID)) return;
  const obs = new MutationObserver(() => { cb(); if (document.getElementById(POST_CONTAINER_ID)) { obs.disconnect(); clearTimeout(t); } });
  obs.observe(document.body, { childList: true, subtree: true });
  const t = setTimeout(() => obs.disconnect(), timeoutMs);
}

// --- クリエイター投稿一覧: 各カードに ⬇ ---
// 最終レビュー3巡目 P3: 1 投稿カードにサムネ・タイトルなど複数の /posts/{id}
// anchor があると、anchor 単位でボタンを付けていた旧実装では同一投稿へ
// ボタンが重複表示された。postId 単位で dedup する。
//
// codex-review 指摘(累積): dedup の判定材料を anchor 側のマーカー(data-fbxdl)に
// 頼る設計は、マーカーをどこに置いても DOM の部分的な再レンダリングで破綻し得る
// ―― 選んだ 1 anchor だけにマークすればそのマーカーだけ消えて重複注入し、同じ
// postId の anchor 全部にマークすれば、逆に実際にボタンを保持している
// anchor/host だけが消えてマーカーだけ生き残り、ボタンが無いのに「既にある」と
// 誤判定して永久に再注入されなくなる。マーカー(anchor 側)と実体(ボタンの生存)
// が別の DOM ノードにある限りこの手の乖離は避けられない。
//
// そのため anchor には一切マークせず、ボタン自身に「どの postId 用か」を
// 記録し(data-fbxdl-for)、「既にボタンがあるか」は現在の DOM に実在する
// ボタン要素を数え上げて判定する。ボタンの DOM ノードが(anchor 差し替え・
// host 差し替え・カード全体の再レンダリングいずれの理由であれ)消えれば、
// 次回呼び出しで自動的に「無い」ことになり、判定がボタンの実在と常に一致する
// (呼び出しをまたぐ独立した状態を持たない)。
//
// 最終レビュー6巡目 P2: FANBOX が SPA/無限スクロールでカードの host ノード
// (anchor の親要素)自体を使い回し、anchor の href だけを別の投稿へ差し替える
// ケースがある。この場合、host には旧 postId 束縛のボタンがまだ実在するため
// 上記の「ボタンの実在で判定」だけでは「既にある」と誤判定してしまい、旧
// postId を握ったボタンが除去されないまま残ってしまう(このカードを押すと
// 別の投稿がダウンロードされる)。
// そこで注入走査のたびに、各 anchor の現在の host を見て「host 内の既存
// ボタンの束縛 postId(data-fbxdl-for)」と「anchor の現在の href から得た
// postId」を比較し、食い違っていれば stale と判断してその場で除去する
// (alreadyInjectedPostIds の集計より前に行うことで、除去した分は自動的に
// 「無い」side に回り、直後の走査で新 postId のボタンとして再注入される)。
// codex-review 指摘(最終レビュー6巡目・native): ボタンは常に
// host.appendChild(btn) で host の「直接の子」として追加される(下の注入
// ループ参照)。通常の querySelector は host 配下の subtree 全体を深く探索
// するため、入れ子 anchor 構造(共有コンテナ側の外側 anchor の host が、
// 個々のカード側の内側 anchor の host を子孫として含むケース。上の
// codex-review 指摘(累積)コメント参照)でこれを使うと、外側 anchor の走査
// 時に無関係な別カード(内側 anchor)のボタンまで拾って「stale」と誤判定し
// 除去してしまう。":scope >" で host の直接の子だけに限定し、この host 自身
// が実際に保持しているボタンだけを見る。
// 不変条件: ボタンの click ハンドラが握る postId は、常にそのボタンが実在
// する host に対応する anchor の「現在の」href の postId と一致する
// (host 再利用で anchor href だけが差し替わっても、古い postId を握った
// ボタンが生き残ることはない)。
const INJECTED_BUTTON_SELECTOR = "[data-fbxdl-for]";
function injectListButtons() {
  const selector = 'a[href*="/posts/"]';
  const anchors: HTMLAnchorElement[] = Array.from(document.querySelectorAll(selector));
  const postIds = anchors.map((a) => postIdFromHref(a.getAttribute("href") || ""));

  // stale 検出: host が再利用され anchor の href(postId)だけが差し替わった
  // 場合、host に残る既存ボタンは古い postId を束縛したままになる。現在の
  // postId と食い違うボタンはここで除去し、以後の「既にある」判定
  // (alreadyInjectedPostIds)から外す。
  for (let i = 0; i < anchors.length; i++) {
    const postId = postIds[i];
    if (!postId) continue;
    const host = anchors[i].parentElement ?? anchors[i];
    const existingBtn = host.querySelector<HTMLElement>(`:scope > ${INJECTED_BUTTON_SELECTOR}`);
    if (existingBtn && existingBtn.dataset.fbxdlFor && existingBtn.dataset.fbxdlFor !== postId) {
      existingBtn.remove();
    }
  }

  const alreadyInjectedPostIds = new Set(
    Array.from(document.querySelectorAll<HTMLElement>(INJECTED_BUTTON_SELECTOR))
      .map((el) => el.dataset.fbxdlFor)
      .filter((id): id is string => !!id)
  );
  const indices = selectPostAnchorIndicesToInject(postIds, alreadyInjectedPostIds);
  for (const i of indices) {
    const anchor = anchors[i];
    const postId = postIds[i];
    if (!postId) continue;
    const host = anchor.parentElement ?? anchor;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const btn = makeDlButton("⬇", true, () => runDownloadFor(postId));
    btn.dataset.fbxdlFor = postId; // このボタンがどの postId 用かを記録(生存確認に使う)
    Object.assign(btn.style, { position: "absolute", top: "6px", right: "6px", zIndex: "9999" });
    host.appendChild(btn);
  }
}

// --- SPA 追随 ---
let lastPath = "";
function sync() {
  const path = location.pathname;
  const onPost = postIdFromPathname(path) !== null;
  const onList = isCreatorPostListPage(path, location.host);
  // 投稿ページ用ボタンは詳細ページ以外では消す
  if (!onPost) document.getElementById(POST_CONTAINER_ID)?.remove();
  if (onPost) whenReady(() => placePostButton());
  if (onList) injectListButtons();
}
function watch() {
  const check = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      sync();
    }
    // 最終レビュー修正 P2a: 投稿ページボタンは title サブトゥリー内に挿入される
    // ため、FANBOX がその subtree を再描画するとボタンごと消えることがある。
    // pathname は変わらないので上の分岐では拾えない。pathname 変化検知とは
    // 独立に、毎周期「投稿ページなのにボタンが無い」かを確認して復活させる
    // (placePostButton は #fbxdl-post-btn 存在ガードで冪等 = 二重注入しない)。
    //
    // codex-review 指摘(round5 P3)+ E2E 退行対応: 投稿ページでは毎周期
    // placePostButton() を呼ぶ。ボタンの有無や placement で呼び出しを間引くと、
    // 誤アンカー・subtree 再描画による消失・アンカーの遅延出現をどれも拾えない
    // ケースが生じる(終端状態バグの温床)。冪等ガード(最良アンカーの直後に
    // 配置済みなら即 return)は placePostButton 側にあるため、毎周期呼んでも
    // コストは h1 走査 1 回分で済む。
    if (postIdFromPathname(location.pathname) !== null) placePostButton();
  };
  window.addEventListener("popstate", check);
  setInterval(check, 1000);
  // 一覧の無限スクロール等でカードが増えるのを拾う(現在が一覧のときのみ注入)
  new MutationObserver(() => { if (isCreatorPostListPage(location.pathname, location.host)) injectListButtons(); })
    .observe(document.body, { childList: true, subtree: true });
  check();
}
watch();
