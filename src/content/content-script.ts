import { fetchPostInfo } from "../fanbox/api";
import { postIdFromPathname, postIdFromHref, isCreatorPostListPage } from "./dom-helpers";
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
function placePostButton(postId: string) {
  if (document.getElementById(POST_CONTAINER_ID)) return;
  const btn = makeDlButton("⬇ fanbox-dl", false, () => runDownloadFor(postId));
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
function injectListButtons() {
  const selector = 'a[href*="/posts/"]';
  const anchors: HTMLAnchorElement[] = Array.from(document.querySelectorAll(selector));
  for (const anchor of anchors) {
    const postId = postIdFromHref(anchor.getAttribute("href") || "");
    if (!postId || anchor.dataset.fbxdl === "1") continue;
    anchor.dataset.fbxdl = "1";
    const host = anchor.parentElement ?? anchor;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const btn = makeDlButton("⬇", true, () => runDownloadFor(postId));
    Object.assign(btn.style, { position: "absolute", top: "6px", right: "6px", zIndex: "9999" });
    host.appendChild(btn);
  }
}

// --- SPA 追随 ---
let lastPath = "";
function sync() {
  const path = location.pathname;
  const onPost = postIdFromPathname(path) !== null;
  const onList = isCreatorPostListPage(path);
  // 投稿ページ用ボタンは詳細ページ以外では消す
  if (!onPost) document.getElementById(POST_CONTAINER_ID)?.remove();
  if (onPost) whenReady(() => placePostButton(postIdFromPathname(path)!));
  if (onList) injectListButtons();
}
function watch() {
  const check = () => { if (location.pathname !== lastPath) { lastPath = location.pathname; sync(); } };
  window.addEventListener("popstate", check);
  setInterval(check, 1000);
  // 一覧の無限スクロール等でカードが増えるのを拾う(現在が一覧のときのみ注入)
  new MutationObserver(() => { if (isCreatorPostListPage(location.pathname)) injectListButtons(); })
    .observe(document.body, { childList: true, subtree: true });
  check();
}
watch();
