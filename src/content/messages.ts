// content script -> SW のメッセージ。post.info の fetch は content script(isolated world)が行い(spec §4a)、
// その json を渡す。SW は受領 json を検証してから使う。
export interface DownloadRequestMessage {
  kind: "download";
  postId: string;
  json: unknown;
}

export interface DownloadResponse {
  queued: number;
  zipQueued: number;
  notices: string[];
  errors: string[];
}

// /posts/{id}(サブドメイン形式)と /@{slug}/posts/{id}(www 形式)の両対応
export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}
