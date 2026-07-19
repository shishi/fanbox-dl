### Task 13: messages + content script(ボタン注入・SPA 対応)

**Files:**
- Create: `src/content/messages.ts`
- Create: `src/content/content-script.ts`
- Test: なし(DOM/chrome 依存の薄い層。ロジックは SW 側に集約済み。postId 抽出だけ単体テスト)
- Test: `tests/post-id.test.ts`

**Interfaces:**
- Consumes: なし
- Produces(Task 15 の SW が受ける):

```ts
export interface DownloadRequestMessage { kind: "download"; postId: string; force: boolean; json: unknown; }
// spec §4a: post.info の fetch は content script(isolated world)が行い、その json を
// この message で SW へ渡す(SW fetch は api.fanbox.cc の Origin ゲートで 400。gate §13-6 実測)。
// SW は受領 json を validatePostInfo(schema)+ allowlist で検証してから使う。
export interface DownloadResponse { queued: number; zipQueued: number; notices: string[]; errors: string[]; }
export interface ClearHistoryMessage { kind: "clearHistory"; }
export function postIdFromPathname(pathname: string): string | null;
```

**fantia-dl との違い**: parse/render/zip はすべて SW に移ったため(spec §3)、content script は「postId を取って SW に依頼して結果を表示する」だけの薄い層。page script・CSRF・fflate import は存在しない。SPA 遷移(spec §12)は popstate + 1 秒間隔の URL 監視で検知する。**matches は `https://*.fanbox.cc/*` 全域**(クリエイタートップで初期ロードされても常駐し、投稿への SPA 遷移でボタンを出す。投稿 URL 限定だと script 自体が載らず spec §13-4 が通らない)。ボタンの出し入れは `syncButton()` の URL 判定が担う。

- [ ] **Step 1: postId 抽出の失敗テストを書く**

`tests/post-id.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { postIdFromPathname } from "../src/content/messages";

describe("postIdFromPathname", () => {
  it("サブドメイン形式 /posts/{id}", () => {
    expect(postIdFromPathname("/posts/12272980")).toBe("12272980");
  });
  it("www 形式 /@creator/posts/{id}", () => {
    expect(postIdFromPathname("/@ropy/posts/12272980")).toBe("12272980");
  });
  it("投稿ページ以外は null", () => {
    expect(postIdFromPathname("/")).toBeNull();
    expect(postIdFromPathname("/@ropy")).toBeNull();
    expect(postIdFromPathname("/posts")).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL

- [ ] **Step 3: messages.ts を実装**

`src/content/messages.ts`:

```ts
// content script -> SW のメッセージ。parse/render/zip/検証 は SW 側(spec §3)。
// ただし post.info の fetch だけは content script(isolated world)が行い(§4a)、
// その json を渡す。SW は受領 json を検証してから使う。
export interface DownloadRequestMessage {
  kind: "download";
  postId: string;
  force: boolean;
  json: unknown; // content script が isolated world で fetch した post.info 応答
}

export interface DownloadResponse {
  queued: number;
  zipQueued: number;
  notices: string[]; // 非致命の通知(updatedDatetime 警告・zip フォールバック等)
  errors: string[];  // 明示エラー
}

export interface ClearHistoryMessage {
  kind: "clearHistory";
}

// /posts/{id}(サブドメイン形式)と /@{slug}/posts/{id}(www 形式)の両対応(spec §12)
export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}
```

- [ ] **Step 4: content-script.ts を実装**

`src/content/content-script.ts`:

```ts
import { postIdFromPathname, type DownloadRequestMessage, type DownloadResponse } from "./messages";
import { fetchPostInfo } from "../fanbox/api";

const CONTAINER_ID = "fbxdl-btn-container";

async function runDownload(force: boolean): Promise<DownloadResponse | null> {
  const postId = postIdFromPathname(location.pathname);
  if (!postId) { alert("[fanbox-dl] postId 不明"); return null; }
  // spec §4a: post.info は content script(isolated world)が fetch する。
  // ページオリジン(https://www.fanbox.cc)が Origin として載るため api.fanbox.cc の
  // 400(Origin ゲート)を回避できる。得た json を SW へ渡す(SW が検証・parse・enqueue)。
  const fetched = await fetchPostInfo(postId);
  if (!fetched.ok) { alert(`[fanbox-dl] 取得失敗: ${fetched.error}`); return null; }
  const res = (await chrome.runtime.sendMessage({
    kind: "download", postId, force, json: fetched.json,
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
    runDownload(false).then((r) => {
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
    runDownload(true).then((r) => {
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
```

- [ ] **Step 5: green + 型チェック + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: thin content script with SPA-aware button injection" -m "spec §3/§12: parse/render/zip を SW に集約したため content script は postId 抽出と依頼のみ。page script と CSRF 機構は存在しない(§4a)。SPA 遷移は popstate+定期監視で追随。"'
```

---

