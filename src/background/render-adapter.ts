import type { PostData, ContentBlock, FileItem, RenderContext } from "../core/types";

// spec §6 render 境界 adapter: blockOrdinal -> RenderContext.contentId の写像は
// この 2 関数だけが行う。identity(stableContentId)は決してここを通らない。

// 最終レビュー修正 P2: core の template-engine は raw.split("/") でパス区切りを
// 作るため、プレースホルダ値(サーバ由来の文字列)に / や \ が含まれると
// sanitize 前に分割され、意図しないサブフォルダ化・traversal を招く。
// core は無改造のまま、この adapter でサーバ由来の値を _ に中和してから
// RenderContext に格納する(後段の sanitizeSegment(core)による二重防御)。
export function neutralizePathSeparators(s: string): string {
  return s.replace(/[/\\]/g, "_");
}

export function buildRenderContext(
  post: PostData, block: ContentBlock, item: FileItem, now: Date,
): RenderContext {
  return {
    creator: neutralizePathSeparators(post.creator),
    creatorId: neutralizePathSeparators(post.creatorId),
    postTitle: neutralizePathSeparators(post.postTitle), postId: post.postId,
    postedAt: post.publishedAt, now,
    contentTitle: "",                       // fanbox に contentTitle は無い(spec §5)
    contentId: String(block.blockOrdinal),
    contentType: neutralizePathSeparators(item.contentType),
    plan: neutralizePathSeparators(String(post.fee)),
    filename: neutralizePathSeparators(item.filename ?? ""),
    ext: neutralizePathSeparators(item.ext),
    seq: item.seq, total: item.total,
  };
}

export function buildZipRenderContext(
  post: PostData, block: ContentBlock, now: Date,
): RenderContext {
  const first = block.files[0];
  return {
    creator: neutralizePathSeparators(post.creator),
    creatorId: neutralizePathSeparators(post.creatorId),
    postTitle: neutralizePathSeparators(post.postTitle), postId: post.postId,
    postedAt: post.publishedAt, now,
    contentTitle: "",
    contentId: String(block.blockOrdinal),
    contentType: "photo",
    plan: neutralizePathSeparators(String(post.fee)),
    filename: neutralizePathSeparators(first?.filename ?? ""),
    ext: "zip",
    seq: 1, total: 1,
  };
}
