import { fetchPostInfo } from "../fanbox/api";
import { postIdFromPathname, postIdFromHref, isCreatorPostListPage, selectPostAnchorIndicesToInject } from "./dom-helpers";
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
  Object.assign(b.style, {
    padding: small ? "2px 8px" : "6px 12px", borderRadius: "6px", cursor: "pointer",
    fontSize: small ? "12px" : "14px", border: "1px solid rgba(0,0,0,.2)",
    background: "#fff", color: "#222", lineHeight: "1.4",
  });
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
    ev.preventDefault(); ev.stopPropagation();
    b.disabled = true;
    onClick().then((r) => { if (r) swapText(b, `⬇ ${r.queued + r.zipQueued} 件開始`); else b.disabled = false; })
      .catch(() => { b.disabled = false; });
  });
  return b;
}

// --- 投稿ページ: タイトル近く(fallback 固定右下) ---
const POST_CONTAINER_ID = "fbxdl-post-btn";
function findTitleAnchor(): HTMLElement | null {
  // ハッシュ化クラスに依存せず、main/article 内の最初の h1、無ければページ最初の h1。
  const scopes = [document.querySelector("article"), document.querySelector("main"), document.body];
  for (const scope of scopes) {
    const h = scope?.querySelector<HTMLElement>("h1");
    if (h && h.textContent && h.textContent.trim().length > 0) return h;
  }
  return null;
}
// 最終レビュー修正 P1a: 投稿ページボタンの click は、生成時にクロージャで
// 握った postId ではなく、クリック時点の location.pathname から都度読む。
// post→post の SPA 遷移では既存ボタンが再利用され続ける(早期 return)ため、
// クロージャの postId を握ったままだと旧投稿がずっと DL されてしまう。
// カードボタン(injectListButtons)は各カード固有の postId を握ったままで正しいので対象外。
function placePostButton() {
  if (document.getElementById(POST_CONTAINER_ID)) return;
  const btn = makeDlButton("⬇ fanbox-dl", false, () => {
    const currentPostId = postIdFromPathname(location.pathname);
    return currentPostId ? runDownloadFor(currentPostId) : Promise.resolve(null);
  });
  btn.id = POST_CONTAINER_ID;
  const title = findTitleAnchor();
  if (title && title.parentElement) {
    btn.style.marginLeft = "12px";
    title.insertAdjacentElement("afterend", btn);
  } else {
    // フォールバック: 固定右下(必ず出る)
    Object.assign(btn.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "99999" });
    document.body.appendChild(btn);
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
const INJECTED_BUTTON_SELECTOR = "[data-fbxdl-for]";
function injectListButtons() {
  const selector = 'a[href*="/posts/"]';
  const anchors: HTMLAnchorElement[] = Array.from(document.querySelectorAll(selector));
  const postIds = anchors.map((a) => postIdFromHref(a.getAttribute("href") || ""));
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
  };
  window.addEventListener("popstate", check);
  setInterval(check, 1000);
  // 一覧の無限スクロール等でカードが増えるのを拾う(現在が一覧のときのみ注入)
  new MutationObserver(() => { if (isCreatorPostListPage(location.pathname, location.host)) injectListButtons(); })
    .observe(document.body, { childList: true, subtree: true });
  check();
}
watch();
