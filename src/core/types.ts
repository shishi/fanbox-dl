// src/core/types.ts
export type ContentType = "photo" | "file" | "video";

export interface FileItem {
  contentType: ContentType;
  url: string;               // downloads.fanbox.cc の直 URL(zip の buffers キーにも使う=post 内で一意)
  filename: string | null;   // file: name(拡張子なし) / image: URL basename(ハッシュ)
  ext: string;               // 拡張子(ドットなし)
  size?: number;             // file item のみ(zip 事前サイズチェック用)
  seq: number;               // ブロック内 1-based(重複スキップ後)
  total: number;             // ブロック内総数(重複スキップ後)
}

export interface ContentBlock {
  blockOrdinal: number;      // post 内 1-based 通し番号($contentId の値。識別子ではない)
  contentType: ContentType;
  files: FileItem[];
}

export interface PostData {
  postId: string;
  postTitle: string;
  creator: string;           // user.name
  creatorId: string;         // creatorId(人間可読スラグ)
  fee: number;               // feeRequired($plan は String(fee))
  publishedAt: Date;         // publishedDatetime
  restricted: boolean;       // isRestricted / body:null
  postType: string;          // "image" | "file" | "article" | "text" | 未知
  skippedEmbeds: number;     // embed/url_embed/未知メディアブロックの件数(spec §2: 対象外・通知のみ)
  contents: ContentBlock[];
}

// core の template-engine が読む型。fantia-dl と完全同一(無改造 core の契約)。
// contentId へは render adapter が blockOrdinal を写す(spec §6)。
export interface RenderContext {
  creator: string; creatorId: string;
  postTitle: string; postId: string;
  postedAt: Date; now: Date;
  contentTitle: string; contentId: string; contentType: string; plan: string;
  filename: string; ext: string;
  seq: number; total: number;
}

// conflictAction は設定として存在しない(spec §8/§14: uniquify 固定)。
export interface Settings {
  pathTemplate: string;
  illegalCharReplacement: string;
  contentTypes: { photo: boolean; file: boolean; video: boolean };
  segmentMaxLen: number;
  fullPathMaxLen: number;
  uniquifyHeadroom: number;
  zipGalleries: boolean;
  zipPathTemplate: string;
  zipEntryTemplate: string;
}
