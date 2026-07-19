### Task 12: fanbox/api.ts — post.info fetch + schema 検証 + リトライ(TDD・spec §4a / §11)

**Files:**
- Create: `src/fanbox/api.ts`
- Test: `tests/fanbox-api.test.ts`

**モジュール位置(spec §4a)**: `fetchPostInfo` は **content script(isolated world)** が呼ぶ
(SW fetch は api.fanbox.cc の Origin ゲートで 400。gate §13-6 実測)。`validatePostInfo` は
**SW(orchestrator)** が受領 json に対して呼ぶ。両者を跨ぐため中立の `src/fanbox/api.ts` に置く
(fetch ロジックはテスト用に fetchFn 注入可能な純粋寄り実装。実 fetch には `credentials:"include"` のみ)。

**Interfaces:**
- Consumes: なし
- Produces:

```ts
export type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; ok: boolean; json(): Promise<any> }>;
export function fetchPostInfo(
  postId: string,
  deps?: { fetchFn?: FetchLike; sleep?: (ms: number) => Promise<void> },
): Promise<{ ok: true; json: any } | { ok: false; error: string }>;
export function validatePostInfo(json: any, postId: string): string | null; // エラー文字列 or null
```

**規則**(spec §11 / §4a): 429・ネットワーク例外は **5 秒バックオフで 1 回だけ**リトライ、再失敗は「時間を置いて再試行して」を含む明示エラー。それ以外の非 200 は即エラー。schema 検証: `body.post.id === postId`(文字列比較)、`body.post.type` が string であること。不一致は「応答が要求と一致しない」エラー。

- [ ] **Step 1: 失敗テストを書く**

`tests/fanbox-api.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fetchPostInfo, validatePostInfo } from "../src/fanbox/api";

const res = (status: number, body: any) => ({ status, ok: status === 200, json: async () => body });
const noSleep = async () => {};

describe("fetchPostInfo", () => {
  it("200 なら json を返す", async () => {
    const r = await fetchPostInfo("1", { fetchFn: async () => res(200, { body: { post: { id: "1", type: "image" } } }), sleep: noSleep });
    expect(r.ok).toBe(true);
  });
  it("429 は 1 回だけリトライして成功できる", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => (++n === 1 ? res(429, null) : res(200, { body: { post: { id: "1", type: "image" } } })), sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });
  it("429 が 2 回続いたら明示エラー(リトライは 1 回まで)", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => { n++; return res(429, null); }, sleep: noSleep });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("時間を置いて");
    expect(n).toBe(2);
  });
  it("ネットワーク例外もリトライ対象", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => { if (++n === 1) throw new Error("net"); return res(200, { body: { post: { id: "1", type: "image" } } }); }, sleep: noSleep });
    expect(r.ok).toBe(true);
  });
  it("403 等はリトライせず即エラー", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => { n++; return res(403, null); }, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
  });
});

describe("validatePostInfo (spec §4a schema 検証)", () => {
  it("id 一致 + type 既知形状で null", () => {
    expect(validatePostInfo({ body: { post: { id: "5", type: "article", isRestricted: false, body: { blocks: [], imageMap: {}, fileMap: {}, embedMap: {}, urlEmbedMap: {} } } } }, "5")).toBeNull();
  });
  it("article は embedMap / urlEmbedMap を欠くと既知の形ではない (spec §4)", () => {
    expect(validatePostInfo({ body: { post: { id: "5", type: "article", isRestricted: false, body: { blocks: [], imageMap: {}, fileMap: {} } } } }, "5")).not.toBeNull();
  });
  it("body:null は isRestricted によらず schema を通す (spec §6: parse が restricted 扱いにして『アクセス権なし』を通知する契約)", () => {
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: false, body: null } } }, "5")).toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: true, body: null } } }, "5")).toBeNull();
  });
  it("postId 不一致はエラー", () => {
    expect(validatePostInfo({ body: { post: { id: "6", type: "image" } } }, "5")).toContain("一致しない");
  });
  it("構造が壊れていたらエラー", () => {
    expect(validatePostInfo({}, "5")).not.toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5" } } }, "5")).not.toBeNull();
  });
  it("既知 type の body 形状も検証する (spec §4a 既知の形)", () => {
    // image なのに images が配列でない / article なのに blocks が無い -> エラー
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: false, body: { images: "x" } } } }, "5")).not.toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5", type: "file", isRestricted: false, body: {} } } }, "5")).not.toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5", type: "article", isRestricted: false, body: { blocks: [], imageMap: null, fileMap: {}, embedMap: {}, urlEmbedMap: {} } } } }, "5")).not.toBeNull();
    // 正常形は OK
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: false, body: { images: [] } } } }, "5")).toBeNull();
    // 制限付き(body null)は OK(親の isRestricted で判定される)
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: true, body: null } } }, "5")).toBeNull();
    // 未知 type は schema ではエラーにしない(spec §2: parse が空を返しスキップ+通知)
    expect(validatePostInfo({ body: { post: { id: "5", type: "mystery", isRestricted: false, body: {} } } }, "5")).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL

- [ ] **Step 3: 実装**

`src/fanbox/api.ts`:

```ts
// spec §4a: post.info fetch(content script が isolated world で呼ぶ)+ SW 側の schema 検証。
// spec §11: 429/ネットワーク失敗は 5 秒バックオフで 1 回だけリトライ。
export type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; ok: boolean; json(): Promise<any> }>;

const API = "https://api.fanbox.cc/post.info?postId=";
const BACKOFF_MS = 5_000;

export function validatePostInfo(json: any, postId: string): string | null {
  const post = json?.body?.post;
  if (!post || typeof post !== "object") return "post.info の応答構造が不正です";
  if (String(post.id) !== postId) return `応答が要求と一致しない (postId ${post.id} != ${postId})`;
  if (typeof post.type !== "string") return "post.type が不明な形です";
  // spec §4a: 既知 type は body 構造が既知の形であることまで検証(不一致は enqueue しない)。
  // body:null は isRestricted によらず schema を通す — spec §6 が「body:null は空 PostData +
  // 『アクセス権なし』通知」と定めており、その経路は enqueue に到達しないため fail-open ではない。
  // 未知 type は parse 側でスキップ+通知(spec §2)。
  if (post.body == null) return null;
  const b = post.body;
  if (post.type === "image" && !Array.isArray(b.images)) return "image 投稿の body.images が既知の形ではありません";
  if (post.type === "file" && !Array.isArray(b.files)) return "file 投稿の body.files が既知の形ではありません";
  if (post.type === "article") {
    const maps = [b.imageMap, b.fileMap, b.embedMap, b.urlEmbedMap];
    if (!Array.isArray(b.blocks) || maps.some((m) => typeof m !== "object" || m === null)) {
      return "article 投稿の body 構造が既知の形ではありません";
    }
  }
  return null;
}

export async function fetchPostInfo(
  postId: string,
  deps: { fetchFn?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const once = async (): Promise<{ kind: "ok"; json: any } | { kind: "retryable"; error: string } | { kind: "fatal"; error: string }> => {
    let r: Awaited<ReturnType<FetchLike>>;
    try {
      r = await fetchFn(API + encodeURIComponent(postId), { credentials: "include" });
    } catch (e) {
      return { kind: "retryable", error: String(e) };
    }
    if (r.status === 429) return { kind: "retryable", error: "429 (rate limited)" };
    if (!r.ok) return { kind: "fatal", error: `post.info が status ${r.status} を返しました` };
    return { kind: "ok", json: await r.json() };
  };

  const first = await once();
  if (first.kind === "ok") return { ok: true, json: first.json };
  if (first.kind === "fatal") return { ok: false, error: first.error };
  await sleep(BACKOFF_MS);
  const second = await once();
  if (second.kind === "ok") return { ok: true, json: second.json };
  const detail = second.kind === "fatal" ? second.error : second.error;
  return { ok: false, error: `post.info の取得に失敗しました(${detail})。時間を置いて再試行してください` };
}
```

- [ ] **Step 4: green + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: fanbox post.info client with bounded retry and schema validation" -m "spec §4a/§11: canonical な SW fetch。429/ネットワークのみ 5 秒 1 回リトライし、応答は postId 一致と既知形状を検証してから使う。"'
```

---

