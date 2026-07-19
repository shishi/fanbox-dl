// src/core/types.ts
export type ContentType = "photo" | "file" | "video";

export interface FileItem {
  contentType: ContentType;
  directUrl?: string;        // photo: url.original(署名済み)
  downloadUri?: string;      // file/video: /posts/{postId}/download/{contentId}
  filename: string | null;   // file: 元名(拡張子除く) / photo: URL basename(UUID)
  ext: string;               // 拡張子(ドットなし)
  seq: number;               // ブロック内 1-based index
  total: number;             // ブロック内総数
  idemKey: string;           // 安定キー "postId:contentId:index"
  refetch: { postId: string; contentId: string; index: number };
}

export interface ContentBlock {
  contentId: string;
  contentTitle: string | null;
  contentType: ContentType;
  plan: string | null;
  files: FileItem[];
}

export interface PostData {
  postId: string;
  postTitle: string;
  creator: string;
  creatorId: string;
  fanclubName: string | null;
  postedAt: Date;
  contents: ContentBlock[];
}

export interface RenderContext {
  creator: string; creatorId: string;
  postTitle: string; postId: string;
  postedAt: Date; now: Date;
  contentTitle: string; contentId: string; contentType: string; plan: string;
  filename: string; ext: string;
  seq: number; total: number;
}

export interface Settings {
  pathTemplate: string;
  illegalCharReplacement: string;
  conflictAction: "uniquify" | "overwrite";
  contentTypes: { photo: boolean; file: boolean; video: boolean };
  segmentMaxLen: number;
  fullPathMaxLen: number;
  uniquifyHeadroom: number;
  zipGalleries: boolean;
  zipPathTemplate: string;
  zipEntryTemplate: string;
}
