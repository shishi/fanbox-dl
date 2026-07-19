export function validatePath(
  relPath: string,
  opts: { fullPathMaxLen: number; uniquifyHeadroom: number; conflictAction: "uniquify" | "overwrite"; segmentMaxLen: number }
): { ok: true } | { ok: false; error: string } {
  if (relPath.startsWith("/")) return { ok: false, error: "先頭スラッシュは不可" };
  if (/^[a-zA-Z]:/.test(relPath)) return { ok: false, error: "絶対パス(ドライブレター)は不可" };
  if (relPath.includes("\\")) return { ok: false, error: "バックスラッシュは不可" };
  const segs = relPath.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return { ok: false, error: `不正なセグメント: "${s}"` };
  }
  const headroom = opts.conflictAction === "uniquify" ? opts.uniquifyHeadroom : 0;
  const effMax = opts.fullPathMaxLen - headroom;
  if ([...relPath].length > effMax) return { ok: false, error: `パスが長すぎる(上限 ${effMax})` };
  const last = segs[segs.length - 1];
  const effSeg = opts.segmentMaxLen - headroom;
  if ([...last].length > effSeg) return { ok: false, error: `ファイル名が長すぎる(上限 ${effSeg})` };
  return { ok: true };
}
