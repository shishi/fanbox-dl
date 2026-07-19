// service-worker <-> offscreen document 間のメッセージ型。
//
// offscreen document は create 後も常駐させ、chrome.runtime.sendMessage で
// やり取りする(Port にすると Service Worker が眠って再起動するたびに繋ぎ直しが
// 必要になり、Port の生存管理が余計に複雑になるため、都度 sendMessage の
// request/response で十分と判断)。
//
// target フィールドで判別しているのは、chrome.runtime.sendMessage が拡張内の
// 全 onMessage リスナー(呼び出し元の service worker 自身のリスナーも含む)に
// 届くため、無関係なリスナー(enqueue ハンドラなど)が誤って処理しないように
// するため。
export const OFFSCREEN_TARGET = "offscreen" as const;

export interface OffscreenChunkMessage {
  target: typeof OFFSCREEN_TARGET;
  kind: "zipChunk";
  jobId: string;
  base64: string;
}

export interface OffscreenDoneMessage {
  target: typeof OFFSCREEN_TARGET;
  kind: "zipDone";
  jobId: string;
  mimeType: string;
}

// content-script 側が "end" を送らずに切断した場合(タブクローズ等)に、
// offscreen document 側に溜まった未完了チャンクを破棄させるためのメッセージ。
export interface OffscreenAbortMessage {
  target: typeof OFFSCREEN_TARGET;
  kind: "zipAbort";
  jobId: string;
}

export interface OffscreenRevokeMessage {
  target: typeof OFFSCREEN_TARGET;
  kind: "revoke";
  url: string;
}

export type OffscreenMessage =
  | OffscreenChunkMessage
  | OffscreenDoneMessage
  | OffscreenAbortMessage
  | OffscreenRevokeMessage;

export interface OffscreenOkResult {
  ok: true;
  url: string;
}

export interface OffscreenErrorResult {
  ok: false;
  error: string;
}

export type OffscreenResult = OffscreenOkResult | OffscreenErrorResult;
