### Task 7: failure classifier + adoption 述語(TDD・spec §6 / §7c-1)

**Files:**
- Create: `src/background/failure-classifier.ts`
- Create: `src/background/adoption.ts`
- Test: `tests/failure-classifier.test.ts`, `tests/adoption.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `classifyDownloadError(reason: string | undefined): "terminal_error" | "retry_once" | "needs_page"`
  - `pathMatchesBoundary(absFilename: string, relPath: string): boolean` — セパレータ正規化 + パス境界安全一致。adoption と actualFilename 乖離判定(Task 10)の両方が使う
  - `findAdoptable(candidates: DownloadItemLike[], lease: {url: string; relPath: string; leasedAt: number}): DownloadItemLike | null` — 0 件/複数件は null(adopt 拒否)
  - `interface DownloadItemLike { id: number; url: string; filename: string; startTime: string; state?: string }`

- [ ] **Step 1: 失敗テストを書く**

`tests/failure-classifier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyDownloadError } from "../src/background/failure-classifier";

describe("classifyDownloadError (spec §6)", () => {
  it("USER_* / FILE_* は terminal_error(ページを開いても直らない)", () => {
    expect(classifyDownloadError("USER_CANCELED")).toBe("terminal_error");
    expect(classifyDownloadError("FILE_NO_SPACE")).toBe("terminal_error");
    expect(classifyDownloadError("FILE_NAME_TOO_LONG")).toBe("terminal_error");
  });
  it("NETWORK_* は retry_once", () => {
    expect(classifyDownloadError("NETWORK_FAILED")).toBe("retry_once");
    expect(classifyDownloadError("NETWORK_TIMEOUT")).toBe("retry_once");
  });
  it("SERVER_FORBIDDEN (403) は初回から terminal_error (spec §7a 明示エラー)", () => {
    expect(classifyDownloadError("SERVER_FORBIDDEN")).toBe("terminal_error");
  });
  it("その他の SERVER_* は needs_page(URL 失効・編集の可能性)", () => {
    expect(classifyDownloadError("SERVER_BAD_CONTENT")).toBe("needs_page");
  });
  it("未知・undefined は安全側の terminal_error", () => {
    expect(classifyDownloadError(undefined)).toBe("terminal_error");
    expect(classifyDownloadError("CRASH")).toBe("terminal_error");
  });
});
```

`tests/adoption.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pathMatchesBoundary, findAdoptable, type DownloadItemLike } from "../src/background/adoption";

describe("pathMatchesBoundary", () => {
  it("Windows セパレータを正規化して suffix 一致", () => {
    expect(pathMatchesBoundary("C:\\\\dl\\\\fanbox\\\\a\\\\b.jpg", "fanbox/a/b.jpg")).toBe(true);
    expect(pathMatchesBoundary("/home/u/dl/fanbox/a/b.jpg", "fanbox/a/b.jpg")).toBe(true);
  });
  it("境界誤マッチを拒否 (foobar/baz.jpg vs bar/baz.jpg) (spec §7c-1)", () => {
    expect(pathMatchesBoundary("/dl/foobar/baz.jpg", "bar/baz.jpg")).toBe(false);
  });
  it("完全一致も許可", () => {
    expect(pathMatchesBoundary("fanbox/a/b.jpg", "fanbox/a/b.jpg")).toBe(true);
  });
});

describe("findAdoptable (spec §7c-1)", () => {
  const lease = { url: "https://downloads.fanbox.cc/images/post/1/x.jpg", relPath: "fanbox/a/x.jpg", leasedAt: 1000 };
  const item = (over: Partial<DownloadItemLike>): DownloadItemLike => ({
    id: 1, url: lease.url, filename: "/dl/fanbox/a/x.jpg",
    startTime: new Date(2000).toISOString(), ...over,
  });
  it("URL+パス+startTime>=leasedAt の 3 条件で adopt", () => {
    expect(findAdoptable([item({})], lease)?.id).toBe(1);
  });
  it("URL のみ一致(古い手動 DL 等)は拒否", () => {
    expect(findAdoptable([item({ filename: "/somewhere/else.jpg" })], lease)).toBeNull();
  });
  it("lease より前に始まった項目は拒否", () => {
    expect(findAdoptable([item({ startTime: new Date(500).toISOString() })], lease)).toBeNull();
  });
  it("候補が複数残ったら adopt 拒否(どれが自分の成果か決定できない)", () => {
    expect(findAdoptable([item({ id: 1 }), item({ id: 2 })], lease)).toBeNull();
  });
  it("候補ゼロも null(通常の再投入へ)", () => {
    expect(findAdoptable([], lease)).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL

- [ ] **Step 3: 実装**

`src/background/failure-classifier.ts`:

```ts
// spec §6: needs_page に落とす前の失敗分類。needs_page は「投稿ページを開けば
// 直る可能性がある」失敗にだけ与える。未知は安全側(terminal)に倒す。
export type FailureAction = "terminal_error" | "retry_once" | "needs_page";

export function classifyDownloadError(reason: string | undefined): FailureAction {
  if (!reason) return "terminal_error";
  if (reason.startsWith("NETWORK_")) return "retry_once";
  // spec §6/§7a: 403 は「サーバによる拒否」= 初回から明示 terminal error
  // (有料コンテンツの可能性。編集由来なら次クリックで URL が変わり再投入される)
  if (reason === "SERVER_FORBIDDEN") return "terminal_error";
  if (reason.startsWith("SERVER_")) return "needs_page";
  // USER_* / FILE_* / CRASH / その他未知
  return "terminal_error";
}
```

`src/background/adoption.ts`:

```ts
// spec §7c-1: crash window(lease 済み・downloadId 未永続)の孤児 download を
// 安全に引き取る述語。URL 一致だけの採用は禁止(Fanbox URL は安定・公開のため)。
export interface DownloadItemLike {
  id: number;
  url: string;
  filename: string;   // chrome.downloads は絶対パスを返す
  startTime: string;  // ISO 8601
  state?: string;
}

export function pathMatchesBoundary(absFilename: string, relPath: string): boolean {
  const norm = absFilename.replace(/\\/g, "/");
  return norm === relPath || norm.endsWith("/" + relPath);
}

export function findAdoptable(
  candidates: DownloadItemLike[],
  lease: { url: string; relPath: string; leasedAt: number },
): DownloadItemLike | null {
  const hits = candidates.filter(
    (c) =>
      c.url === lease.url &&
      pathMatchesBoundary(c.filename, lease.relPath) &&
      Date.parse(c.startTime) >= lease.leasedAt,
  );
  // 複数ヒットはどれが自ジョブの成果か決定できないため adopt しない
  // (再投入の最悪ケースは uniquify の重複ファイル 1 個で、欠落・上書きにはならない)。
  return hits.length === 1 ? hits[0] : null;
}
```

- [ ] **Step 4: green + コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: download failure classifier and lease adoption predicate" -m "spec §6 の needs_page 誤分類防止と、spec §7c-1 の crash-window 限定・境界安全・単一候補限定の adoption 規則を純粋関数化。"'
```

---

