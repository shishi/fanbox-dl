const ILLEGAL = /[\/\\:*?"<>|]/g;
const CONTROL = /[\x00-\x1f\x7f]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

const cp = (s: string) => [...s];
function truncCp(s: string, max: number): string {
  const a = cp(s);
  return a.length <= max ? s : a.slice(0, max).join("");
}

export function sanitizeSegment(
  raw: string,
  opts: { replacement: string; maxLen: number; preserveExt?: boolean }
): string {
  let s = (raw ?? "").normalize("NFC");
  s = s.replace(ILLEGAL, opts.replacement).replace(CONTROL, opts.replacement);
  s = s.replace(/^[.\s]+|[.\s]+$/g, "");
  if (s === "") s = "untitled";
  if (cp(s).length > opts.maxLen) {
    if (opts.preserveExt) {
      const dot = s.lastIndexOf(".");
      if (dot > 0) {
        const ext = s.slice(dot);
        const baseMax = Math.max(1, opts.maxLen - cp(ext).length);
        s = truncCp(s.slice(0, dot), baseMax) + ext;
      } else {
        s = truncCp(s, opts.maxLen);
      }
    } else {
      s = truncCp(s, opts.maxLen);
    }
  }
  if (RESERVED.test(s)) s = s + "_";
  return s;
}
