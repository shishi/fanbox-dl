import { postIdFromPathname, type DownloadRequestMessage, type DownloadResponse } from "./messages";
import { fetchPostInfo } from "../fanbox/api";

const CONTAINER_ID = "fbxdl-btn-container";

async function runDownload(): Promise<DownloadResponse | null> {
  const postId = postIdFromPathname(location.pathname);
  if (!postId) { alert("[fanbox-dl] postId 不明"); return null; }
  // spec §4a: post.info は content script(isolated world)が fetch する。
  // ページオリジン(https://www.fanbox.cc)が Origin として載るため api.fanbox.cc の
  // 400(Origin ゲート)を回避できる。得た json を SW へ渡す(SW が検証・parse・enqueue)。
  const fetched = await fetchPostInfo(postId);
  if (!fetched.ok) { alert(`[fanbox-dl] 取得失敗: ${fetched.error}`); return null; }
  const res = (await chrome.runtime.sendMessage({
    kind: "download", postId, json: fetched.json,
  } satisfies DownloadRequestMessage)) as DownloadResponse | undefined;
  if (!res) { alert("[fanbox-dl] background から応答がありません"); return null; }
  if (res.errors.length) alert(`[fanbox-dl] エラー: ${res.errors.join(" / ")}`);
  if (res.notices.length) alert(`[fanbox-dl] お知らせ:\n${res.notices.join("\n")}`);
  return res;
}

function styleBtn(b: HTMLButtonElement) {
  Object.assign(b.style, { padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "14px" });
}

function swapText(b: HTMLButtonElement, temp: string, ms = 2500) {
  const orig = b.dataset.origText ?? b.textContent ?? "";
  if (!b.dataset.origText) b.dataset.origText = orig;
  b.textContent = temp;
  setTimeout(() => { b.textContent = b.dataset.origText || orig; b.disabled = false; }, ms);
}

function addButton() {
  if (document.getElementById(CONTAINER_ID)) return;
  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  // fanbox は SPA でテーマごとに DOM が変わるため、アンカー探索はせず固定表示にする
  Object.assign(container.style, {
    position: "fixed", right: "16px", bottom: "16px", zIndex: "99999",
    display: "flex", gap: "8px",
  });

  const btn = document.createElement("button");
  btn.id = "fbxdl-btn"; btn.type = "button"; btn.textContent = "⬇ fanbox-dl";
  btn.title = "ダウンロード(履歴があれば済んだ分はスキップ)";
  styleBtn(btn);
  btn.addEventListener("click", () => {
    btn.disabled = true;
    runDownload().then((r) => {
      if (r) swapText(btn, `⬇ ${r.queued + r.zipQueued} 件開始`);
      else btn.disabled = false;
    }).catch(() => { btn.disabled = false; });
  });

  const retryBtn = document.createElement("button");
  retryBtn.id = "fbxdl-retry-btn"; retryBtn.type = "button"; retryBtn.textContent = "🔄";
  retryBtn.title = "やり直し(この投稿を新しい世代として再ダウンロード)";
  styleBtn(retryBtn);
  retryBtn.addEventListener("click", () => {
    if (!confirm("この投稿を再ダウンロードします(旧ファイルは消えません)。よろしいですか?")) return;
    retryBtn.disabled = true;
    runDownload().then((r) => {
      if (r) swapText(retryBtn, `🔄 ${r.queued + r.zipQueued} 件`);
      else retryBtn.disabled = false;
    }).catch(() => { retryBtn.disabled = false; });
  });

  container.appendChild(btn);
  container.appendChild(retryBtn);
  document.body.appendChild(container);
}

function syncButton() {
  const onPost = postIdFromPathname(location.pathname) !== null;
  const existing = document.getElementById(CONTAINER_ID);
  if (onPost && !existing) addButton();
  if (!onPost && existing) existing.remove();
}

// spec §12: SPA 内遷移はページリロードを起こさないため popstate + 定期チェックで検知
let lastPath = "";
function watchNavigation() {
  const check = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      syncButton();
    }
  };
  window.addEventListener("popstate", check);
  setInterval(check, 1000);
  check();
}

watchNavigation();
