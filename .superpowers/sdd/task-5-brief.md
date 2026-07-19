### Task 5: メディア URL allowlist(TDD・spec §4a)

**Files:**
- Create: `src/core/url-allowlist.ts`
- Test: `tests/url-allowlist.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `validateMediaUrl(url: string, postId: string): { ok: true } | { ok: false; error: string }` — SW があらゆるネットワーク使用(downloads.download / zip 用 fetch / needs_page 回復)の前に必ず呼ぶ

- [ ] **Step 1: 失敗テストを書く**

`tests/url-allowlist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateMediaUrl } from "../src/core/url-allowlist";

describe("validateMediaUrl", () => {
  const ok = (u: string, p = "111") => expect(validateMediaUrl(u, p).ok).toBe(true);
  const ng = (u: string, p = "111") => expect(validateMediaUrl(u, p).ok).toBe(false);

  it("images/files の正規 URL を許可", () => {
    ok("https://downloads.fanbox.cc/images/post/111/abc.jpeg");
    ok("https://downloads.fanbox.cc/files/post/111/abc.mp4");
  });
  it("ホスト違いを拒否(サブドメイン偽装含む)", () => {
    ng("https://evil.example.com/images/post/111/a.jpeg");
    ng("https://downloads.fanbox.cc.evil.example/images/post/111/a.jpeg");
    ng("https://api.fanbox.cc/images/post/111/a.jpeg");
  });
  it("http(非 https)を拒否", () => {
    ng("http://downloads.fanbox.cc/images/post/111/a.jpeg");
  });
  it("パス形状違いを拒否", () => {
    ng("https://downloads.fanbox.cc/other/post/111/a.jpeg");
    ng("https://downloads.fanbox.cc/images/post/111"); // ファイル名なし
  });
  it("postId 不一致を拒否 (confused deputy 防止)", () => {
    ng("https://downloads.fanbox.cc/images/post/222/a.jpeg", "111");
  });
  it("トラバーサル・URL でないものを拒否", () => {
    ng("https://downloads.fanbox.cc/images/post/111/../222/a.jpeg");
    ng("not a url");
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL(モジュール未作成)

- [ ] **Step 3: 実装**

`src/core/url-allowlist.ts`:

```ts
// spec §4a: parse 層由来のメディア URL は、あらゆるネットワーク使用の前に
// このホスト+パス形状 allowlist を通す(confused deputy 防止)。
const ALLOWED_HOST = "downloads.fanbox.cc";

export function validateMediaUrl(
  url: string,
  postId: string,
): { ok: true } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `URL として不正: ${url}` };
  }
  if (u.protocol !== "https:") return { ok: false, error: `https 以外: ${url}` };
  if (u.host !== ALLOWED_HOST) return { ok: false, error: `許可外ホスト: ${u.host}` };
  // URL パーサ通過後の pathname で判定(../ は正規化されるため postId 照合が本丸)
  const m = u.pathname.match(/^\/(images|files)\/post\/([^/]+)\/[^/]+$/);
  if (!m) return { ok: false, error: `許可外パス形状: ${u.pathname}` };
  if (m[2] !== postId) return { ok: false, error: `postId 不一致: ${m[2]} != ${postId}` };
  return { ok: true };
}
```

- [ ] **Step 4: green + 型チェック**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck'
```

Expected: 全 PASS(トラバーサルのテストは URL 正規化で `/images/post/222/a.jpeg` になり postId 不一致で落ちる)

- [ ] **Step 5: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "feat: media URL allowlist guard" -m "spec §4a: 拡張権限・拡張 cookie 文脈での任意 URL fetch/DL(confused deputy)を、host+path 形状+postId 一致の純粋関数ゲートで全ネットワーク経路の手前に置く。"'
```

---

