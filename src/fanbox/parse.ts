import type { PostData, ContentBlock, FileItem } from "../core/types";

const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

function urlBasenameNoExt(url: string): string {
  const path = url.split("?")[0];
  const base = path.substring(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

interface RawImage { id: string; extension: string; originalUrl: string }
interface RawFile { id: string; name: string; extension: string; url: string; size?: number }

function imageToItem(im: RawImage): Omit<FileItem, "seq" | "total"> {
  return {
    contentType: "photo",
    url: im.originalUrl,
    filename: urlBasenameNoExt(im.originalUrl),
    ext: (im.extension || "").toLowerCase(),
    idemKey: "", stableContentId: `image:${im.id}`,
    refetch: { postId: "", stableContentId: `image:${im.id}`, index: 0 },
  };
}

function fileToItem(f: RawFile): Omit<FileItem, "seq" | "total"> {
  const ext = (f.extension || "").toLowerCase();
  return {
    contentType: VIDEO_EXT.has(ext) ? "video" : "file",
    url: f.url,
    filename: f.name ?? null,
    ext,
    size: typeof f.size === "number" ? f.size : undefined,
    idemKey: "", stableContentId: `file:${f.id}`,
    refetch: { postId: "", stableContentId: `file:${f.id}`, index: 0 },
  };
}

// spec §2: DL 対象が無い投稿の type 別通知文言(text=対象なし / video=対象外(通知のみ) /
// 未知=スキップ+通知)。SW が contents 空のとき使う。
const KNOWN_TYPES = new Set(["image", "file", "article", "text", "video"]);
export function emptyPostNotice(postType: string): string {
  if (postType === "video") return "外部埋め込み動画の投稿のため DL 対象外です";
  if (!KNOWN_TYPES.has(postType)) return `未対応の投稿タイプ(${postType})のためスキップしました`;
  return `この投稿(type: ${postType})に DL 対象はありません`;
}

export function parsePost(json: any): PostData {
  const post = json?.body?.post ?? {};
  const postId = String(post.id ?? "");
  const restricted = post.isRestricted === true || post.body == null;

  const data: PostData = {
    postId,
    postTitle: post.title ?? "",
    creator: post.user?.name ?? "",
    creatorId: post.creatorId ?? "",
    fee: typeof post.feeRequired === "number" ? post.feeRequired : 0,
    publishedAt: new Date(post.publishedDatetime ?? 0),
    updatedAtIso: post.updatedDatetime ?? "",
    restricted,
    postType: post.type ?? "",
    skippedEmbeds: 0,
    contents: [],
  };
  if (restricted) return data;

  const b = post.body;
  // group: メディアの並び。image/file 以外のブロックはグループを切らない
  // (p で切るとギャラリーが全部単発になり zip が成立しないため。plan で確定した解釈)。
  const groups: { kind: "image" | "file"; items: Array<Omit<FileItem, "seq" | "total">> }[] = [];
  const seen = { image: new Set<string>(), file: new Set<string>() };
  const push = (kind: "image" | "file", item: Omit<FileItem, "seq" | "total">, rawId: string) => {
    if (seen[kind].has(rawId)) return; // 初出のみ採用(spec §6 重複スキップ・名前空間ごと)
    seen[kind].add(rawId);
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.items.push(item);
    else groups.push({ kind, items: [item] });
  };

  if (post.type === "image") {
    for (const im of b.images ?? []) push("image", imageToItem(im), String(im.id));
  } else if (post.type === "file") {
    for (const f of b.files ?? []) push("file", fileToItem(f), String(f.id));
  } else if (post.type === "article") {
    for (const blk of b.blocks ?? []) {
      if (blk?.type === "image") {
        const im = b.imageMap?.[blk.imageId];
        if (im) push("image", imageToItem(im), String(im.id));
      } else if (blk?.type === "file") {
        const f = b.fileMap?.[blk.fileId];
        if (f) push("file", fileToItem(f), String(f.id));
      } else if (blk?.type === "embed" || blk?.type === "url_embed" || blk?.type === "video") {
        data.skippedEmbeds++; // spec §2: 対象外だが通知は出す(SW 側で notices 化)
      }
      // p / 見出し等の非メディアブロックは無視(グループも切らない)
    }
  }
  // text / video(外部埋め込み) / 未知 type は groups 空のまま

  let ordinal = 0;
  let parseIndex = 0; // spec §6: refetch.index は投稿全体のパース順(整合性チェック専用)
  for (const g of groups) {
    ordinal++;
    const files: FileItem[] = g.items.map((it, i) => ({
      ...it,
      seq: i + 1,
      total: g.items.length,
      idemKey: `${postId}:${it.stableContentId}`,
      refetch: { postId, stableContentId: it.stableContentId, index: parseIndex++ },
    }));
    const block: ContentBlock = {
      blockOrdinal: ordinal,
      contentType: g.kind === "image" ? "photo" : "file",
      files,
    };
    data.contents.push(block);
  }
  return data;
}
