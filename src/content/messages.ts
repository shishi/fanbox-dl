// content script -> SW のメッセージ。parse/render/zip/検証 は SW 側(spec §3)。
// ただし post.info の fetch だけは content script(isolated world)が行い(§4a)、
// その json を渡す。SW は受領 json を検証してから使う。
export interface DownloadRequestMessage {
  kind: "download";
  postId: string;
  force: boolean;
  json: unknown; // content script が isolated world で fetch した post.info 応答
}

export interface DownloadResponse {
  queued: number;
  zipQueued: number;
  notices: string[]; // 非致命の通知(updatedDatetime 警告・zip フォールバック等)
  errors: string[];  // 明示エラー
}

export interface ClearHistoryMessage {
  kind: "clearHistory";
}

// /posts/{id}(サブドメイン形式)と /@{slug}/posts/{id}(www 形式)の両対応(spec §12)
export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}
