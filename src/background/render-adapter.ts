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
