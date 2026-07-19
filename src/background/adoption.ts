// spec §7c-1: crash window(lease 済み・downloadId 未永続)の孤児 download を
// 安全に引き取る述語。URL 一致だけの採用は禁止(Fanbox URL は安定・公開のため)。
export interface DownloadItemLike {
  id: number;
  url: string;
  filename: string;   // chrome.downloads は絶対パスを返す
  startTime: string;  // ISO 8601
  state?: string;
}

export function pathMatchesBoundary(absFilename: string, relPath: string): boolean {
  const norm = absFilename.replace(/\\/g, "/");
  return norm === relPath || norm.endsWith("/" + relPath);
}

export function findAdoptable(
  candidates: DownloadItemLike[],
  lease: { url: string; relPath: string; leasedAt: number },
): DownloadItemLike | null {
  const hits = candidates.filter(
    (c) =>
      c.url === lease.url &&
      pathMatchesBoundary(c.filename, lease.relPath) &&
      Date.parse(c.startTime) >= lease.leasedAt,
  );
  // 複数ヒットはどれが自ジョブの成果か決定できないため adopt しない
  // (再投入の最悪ケースは uniquify の重複ファイル 1 個で、欠落・上書きにはならない)。
  return hits.length === 1 ? hits[0] : null;
}
