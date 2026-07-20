### Task 2: content script のボタン配置(タイトル近く + 一覧カード)

**Files:**
- Create: `src/content/dom-helpers.ts`(純粋関数。単体テスト対象)
- Modify: `src/content/content-script.ts`(全面書き換え)
- Test: `tests/dom-helpers.test.ts`(新規)、`tests/post-id.test.ts`(維持 or dom-helpers へ統合)

**Interfaces:**
- Consumes: `fetchPostInfo`(fanbox/api)、`DownloadRequestMessage`/`DownloadResponse`(messages)
- Produces(dom-helpers.ts の純粋関数):
  - `postIdFromPathname(pathname: string): string | null`(messages から移設 or 再エクスポート)
  - `postIdFromHref(href: string): string | null` — `/@creator/posts/{id}` と `/posts/{id}` の両方から postId 抽出
  - `isCreatorPostListPage(pathname: string): boolean` — `/@{creator}` または `/@{creator}/posts`(末尾)を一覧面と判定。投稿詳細(`/posts/{id}`)は false

**規則(spec §変更 B)**:
- 投稿ページ: タイトル見出し隣にボタン、見つからなければ固定右下フォールバック。🔄 は無し(⬇ のみ)。
- 一覧: `isCreatorPostListPage` のときだけ、`/posts/\d+` にマッチするアンカーを走査して各投稿カードに ⬇ を注入。クリックは `preventDefault()`+`stopPropagation()` でカード遷移を抑止。`MutationObserver` で無限スクロールの新規カードにも注入。重複は `data-fbxdl` 属性でガード。
- content script matches は `*.fanbox.cc/*` 全域常駐のまま(manifest 既存)。

- [ ] **Step 1: dom-helpers の失敗テストを書く**

`tests/dom-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { postIdFromPathname, postIdFromHref, isCreatorPostListPage } from "../src/content/dom-helpers";

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
});

describe("isCreatorPostListPage", () => {
  it("クリエイターページ(投稿一覧)は true", () => {
    expect(isCreatorPostListPage("/@ropy")).toBe(true);
    expect(isCreatorPostListPage("/@ropy/posts")).toBe(true);
  });
  it("投稿詳細・その他は false", () => {
    expect(isCreatorPostListPage("/@ropy/posts/12272980")).toBe(false);
    expect(isCreatorPostListPage("/")).toBe(false);
    expect(isCreatorPostListPage("/@ropy/plans")).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認 → dom-helpers.ts 実装**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH; cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test tests/dom-helpers.test.ts 2>&1 | tail -5'` → FAIL

`src/content/dom-helpers.ts`:

```ts
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
```

Run 同コマンド → PASS。`src/content/messages.ts` の `postIdFromPathname` は dom-helpers から re-export して重複を避ける(messages.ts 末尾を `export { postIdFromPathname } from "./dom-helpers";` に変更)。`tests/post-id.test.ts` は dom-helpers.test.ts と重複するため削除してよい(`git rm tests/post-id.test.ts`)。

- [ ] **Step 3: content-script.ts を全面書き換え**

`src/content/content-script.ts`:

```ts
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
    ev.preventDefault(); ev.stopPropagation(); // 一覧カードのリンク遷移を抑止(spec §変更 B)
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
  cb(); // 既に居るなら即
  if (document.getElementById(POST_CONTAINER_ID)) return;
  const obs = new MutationObserver(() => { cb(); if (document.getElementById(POST_CONTAINER_ID)) { obs.disconnect(); clearTimeout(t); } });
  obs.observe(document.body, { childList: true, subtree: true });
  const t = setTimeout(() => obs.disconnect(), timeoutMs);
}

// --- クリエイター投稿一覧: 各カードに ⬇ ---
function injectListButtons() {
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"]');
  for (const a of anchors) {
    const postId = postIdFromHref(a.getAttribute("href") || "");
    if (!postId || a.dataset.fbxdl === "1") continue;
    a.dataset.fbxdl = "1";
    const host = a.parentElement ?? a;
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
```

- [ ] **Step 4: 全テスト + 型チェック + ビルド**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH; cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | grep -E "Test Files|Tests " && bun run typecheck 2>&1 | tail -1 && bun run build 2>&1 | tail -1'`
Expected: 全 green・型 0・build 成功。

- [ ] **Step 5: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "feat: place DL button near post title and on creator list cards" -m "spec 2026-07-20 変更 B: 投稿ページはタイトル見出し隣(見つからなければ固定右下フォールバック)、クリエイター投稿一覧は href /posts/{id} 検出で各カードに ⬇(preventDefault+stopPropagation でカード遷移抑止・MutationObserver で無限スクロール追随)。🔄 削除。postId/href/一覧判定は純粋関数化して単体テスト。"'
```

---

