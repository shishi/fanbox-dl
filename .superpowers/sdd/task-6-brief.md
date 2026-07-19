### Task 6: canonicalRelPath + render adapter(TDD・spec §7c-2 / §6)

**Files:**
- Create: `src/core/canonical-relpath.ts`
- Create: `src/background/render-adapter.ts`
- Test: `tests/canonical-relpath.test.ts`, `tests/render-adapter.test.ts`

**Interfaces:**
- Consumes: `PostData / ContentBlock / FileItem / RenderContext`(Task 3)
- Produces:
  - `canonicalRelPath(basePath: string, generation: number): string` — gen 0 は basePath そのまま、gen>0 は最終セグメントの拡張子直前に `.rev{generation}` を注入。enqueue・dedup 比較・force・stale-miss・divergent 回復・adoption の全経路がこれを共通利用(spec §7c-2)
  - `buildRenderContext(post: PostData, block: ContentBlock, item: FileItem, now: Date): RenderContext` — blockOrdinal→contentId 写像はこの adapter だけが行う(spec §6)
  - `buildZipRenderContext(post: PostData, block: ContentBlock, now: Date): RenderContext` — zip パス用(ext="zip", seq=1, total=1)

- [ ] **Step 1: 失敗テストを書く**

`tests/canonical-relpath.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canonicalRelPath } from "../src/core/canonical-relpath";

describe("canonicalRelPath", () => {
  it("generation 0 は basePath をそのまま返す", () => {
    expect(canonicalRelPath("a/b/c.jpg", 0)).toBe("a/b/c.jpg");
  });
  it("generation > 0 は最終セグメントの拡張子直前に .rev{N}", () => {
    expect(canonicalRelPath("a/b/c.jpg", 1)).toBe("a/b/c.rev1.jpg");
    expect(canonicalRelPath("a/b/c.jpg", 12)).toBe("a/b/c.rev12.jpg");
  });
  it("拡張子なしの最終セグメントは末尾に .rev{N}", () => {
    expect(canonicalRelPath("a/b/noext", 2)).toBe("a/b/noext.rev2");
  });
  it("ディレクトリ名のドットに惑わされない(最終セグメントだけ見る)", () => {
    expect(canonicalRelPath("v1.0/c.jpg", 1)).toBe("v1.0/c.rev1.jpg");
  });
  it("同じ入力は常に同じ出力(決定性)", () => {
    expect(canonicalRelPath("x/y.png", 3)).toBe(canonicalRelPath("x/y.png", 3));
  });
});
```

`tests/render-adapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRenderContext, buildZipRenderContext } from "../src/background/render-adapter";
import type { PostData, ContentBlock, FileItem } from "../src/core/types";

const post: PostData = {
  postId: "111", postTitle: "T", creator: "C", creatorId: "slug",
  fee: 500, publishedAt: new Date("2026-07-01T03:00:00Z"),
  updatedAtIso: "2026-07-02T12:00:00+09:00", restricted: false, postType: "image",
  skippedEmbeds: 0,
  contents: [],
};
const item: FileItem = {
  contentType: "photo", url: "https://downloads.fanbox.cc/images/post/111/a.jpeg",
  filename: "a", ext: "jpeg", seq: 2, total: 3,
  idemKey: "111:image:a", stableContentId: "image:a",
  refetch: { postId: "111", stableContentId: "image:a", index: 1 },
};
const block: ContentBlock = { blockOrdinal: 4, contentType: "photo", files: [item] };

describe("render adapter (blockOrdinal -> contentId はここだけ)", () => {
  it("buildRenderContext が RenderContext を組み立てる", () => {
    const now = new Date("2026-07-19T00:00:00Z");
    const ctx = buildRenderContext(post, block, item, now);
    expect(ctx.contentId).toBe("4");         // blockOrdinal の写像
    expect(ctx.contentTitle).toBe("");       // fanbox に無い -> [...] で消える
    expect(ctx.plan).toBe("500");            // String(fee)
    expect(ctx.creator).toBe("C");
    expect(ctx.creatorId).toBe("slug");
    expect(ctx.filename).toBe("a");
    expect(ctx.seq).toBe(2);
    expect(ctx.total).toBe(3);
    expect(ctx.now).toBe(now);
  });
  it("buildZipRenderContext は ext=zip / seq=total=1", () => {
    const ctx = buildZipRenderContext(post, block, new Date());
    expect(ctx.contentId).toBe("4");
    expect(ctx.ext).toBe("zip");
    expect(ctx.seq).toBe(1);
    expect(ctx.total).toBe(1);
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL(モジュール未作成)

- [ ] **Step 3: 実装**

`src/core/canonical-relpath.ts`:

```ts
// spec §7c-2: base テンプレ結果 + generation -> canonical relPath の唯一の導出規則。
// dedup 比較・enqueue・force・stale-miss・divergent 回復・adoption すべてがこれを使う。
export function canonicalRelPath(basePath: string, generation: number): string {
  if (generation <= 0) return basePath;
  const slash = basePath.lastIndexOf("/");
  const dir = slash >= 0 ? basePath.slice(0, slash + 1) : "";
  const name = slash >= 0 ? basePath.slice(slash + 1) : basePath;
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${dir}${name.slice(0, dot)}.rev${generation}${name.slice(dot)}`;
  return `${dir}${name}.rev${generation}`;
}
```

`src/background/render-adapter.ts`:

```ts
import type { PostData, ContentBlock, FileItem, RenderContext } from "../core/types";

// spec §6 render 境界 adapter: blockOrdinal -> RenderContext.contentId の写像は
// この 2 関数だけが行う。identity(stableContentId)は決してここを通らない。
export function buildRenderContext(
  post: PostData, block: ContentBlock, item: FileItem, now: Date,
): RenderContext {
  return {
    creator: post.creator, creatorId: post.creatorId,
    postTitle: post.postTitle, postId: post.postId,
    postedAt: post.publishedAt, now,
    contentTitle: "",                       // fanbox に contentTitle は無い(spec §5)
    contentId: String(block.blockOrdinal),
    contentType: item.contentType,
    plan: String(post.fee),
    filename: item.filename ?? "", ext: item.ext,
    seq: item.seq, total: item.total,
  };
}

export function buildZipRenderContext(
  post: PostData, block: ContentBlock, now: Date,
): RenderContext {
  const first = block.files[0];
  return {
    creator: post.creator, creatorId: post.creatorId,
    postTitle: post.postTitle, postId: post.postId,
    postedAt: post.publishedAt, now,
    contentTitle: "",
    contentId: String(block.blockOrdinal),
    contentType: "photo",
    plan: String(post.fee),
    filename: first?.filename ?? "", ext: "zip",
    seq: 1, total: 1,
  };
}
```

- [ ] **Step 4: green + 型チェック → コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck && git add -A && git commit -m "feat: canonical relPath derivation and render-boundary adapter" -m "spec §7c-2 の .rev{generation} 昇格規則を単一の純粋関数に固定し、spec §6 の blockOrdinal->contentId 写像を render 直前の adapter に閉じ込める。"'
```

---

