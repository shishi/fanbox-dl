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
