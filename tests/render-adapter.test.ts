import { describe, it, expect } from "vitest";
import { buildRenderContext, buildZipRenderContext, neutralizePathSeparators } from "../src/background/render-adapter";
import type { PostData, ContentBlock, FileItem } from "../src/core/types";

const post: PostData = {
  postId: "111", postTitle: "T", creator: "C", creatorId: "slug",
  fee: 500, publishedAt: new Date("2026-07-01T03:00:00Z"),
  restricted: false, postType: "image",
  skippedEmbeds: 0,
  contents: [],
};
const item: FileItem = {
  contentType: "photo", url: "https://downloads.fanbox.cc/images/post/111/a.jpeg",
  filename: "a", ext: "jpeg", seq: 2, total: 3,
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

  describe("プレースホルダ値のパスセパレータ中和(最終レビュー修正 P2)", () => {
    it("buildRenderContext: creator/creatorId/postTitle/filename に含まれる / や \\ が _ に中和される(サブフォルダ化しない)", () => {
      const postWithSep: PostData = {
        ...post,
        creator: "A/B", creatorId: "c\\d", postTitle: "T/i\\tle",
      };
      const itemWithSep: FileItem = { ...item, filename: "f/g\\h" };
      const now = new Date("2026-07-19T00:00:00Z");
      const ctx = buildRenderContext(postWithSep, block, itemWithSep, now);
      expect(ctx.creator).toBe("A_B");
      expect(ctx.creatorId).toBe("c_d");
      expect(ctx.postTitle).toBe("T_i_tle");
      expect(ctx.filename).toBe("f_g_h");
    });

    it("buildZipRenderContext: creator/creatorId/postTitle/filename に含まれる / や \\ が _ に中和される", () => {
      const postWithSep: PostData = {
        ...post,
        creator: "X/Y", creatorId: "1\\2", postTitle: "P/Q",
      };
      const firstFile: FileItem = { ...item, filename: "z/y\\x" };
      const blockWithSep: ContentBlock = { ...block, files: [firstFile] };
      const ctx = buildZipRenderContext(postWithSep, blockWithSep, new Date());
      expect(ctx.creator).toBe("X_Y");
      expect(ctx.creatorId).toBe("1_2");
      expect(ctx.postTitle).toBe("P_Q");
      expect(ctx.filename).toBe("z_y_x");
    });

    it("neutralizePathSeparators は / と \\ を _ に置換する純粋関数", () => {
      expect(neutralizePathSeparators("a/b\\c")).toBe("a_b_c");
      expect(neutralizePathSeparators("no-sep")).toBe("no-sep");
      expect(neutralizePathSeparators("")).toBe("");
    });
  });
});
