// spec §6: needs_page に落とす前の失敗分類。needs_page は「投稿ページを開けば
// 直る可能性がある」失敗にだけ与える。未知は安全側(terminal)に倒す。
export type FailureAction = "terminal_error" | "retry_once" | "needs_page";

export function classifyDownloadError(reason: string | undefined): FailureAction {
  if (!reason) return "terminal_error";
  if (reason.startsWith("NETWORK_")) return "retry_once";
  // spec §6/§7a: 403 は「サーバによる拒否」= 初回から明示 terminal error
  // (有料コンテンツの可能性。編集由来なら次クリックで URL が変わり再投入される)
  if (reason === "SERVER_FORBIDDEN") return "terminal_error";
  if (reason.startsWith("SERVER_")) return "needs_page";
  // USER_* / FILE_* / CRASH / その他未知
  return "terminal_error";
}
