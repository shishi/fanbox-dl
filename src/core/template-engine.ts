import type { RenderContext } from "./types";
import { sanitizeSegment } from "./sanitizer";

export class TemplateError extends Error {}

type Node =
  | { t: "lit"; v: string }
  | { t: "ph"; name: string; arg?: string }
  | { t: "grp"; children: Node[] };

const PLACEHOLDER_NAMES = [
  "creatorId", "creator",
  "postTitle", "postId",
  "contentTitle", "contentType", "contentId",
  "date", "today", "plan", "filename", "ext", "seq", "total",
].sort((a, b) => b.length - a.length);

function parse(tpl: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < tpl.length) {
    const c = tpl[i];
    if (c === "[") { const g: Node = { t: "grp", children: [] }; top().push(g); stack.push(g.children); i++; }
    else if (c === "]") { if (stack.length > 1) stack.pop(); else top().push({ t: "lit", v: "]" }); i++; }
    else if (c === "$") {
      const j = i + 1;
      const rest = tpl.slice(j);
      const name = PLACEHOLDER_NAMES.find((nm) => rest.startsWith(nm));
      if (!name) {
        let k = j; let attempted = "";
        while (k < tpl.length && /[a-zA-Z]/.test(tpl[k])) { attempted += tpl[k]; k++; }
        if (attempted === "") { top().push({ t: "lit", v: "$" }); i++; continue; }
        throw new TemplateError(`unknown placeholder: \$${attempted}`);
      }
      let k = j + name.length;
      let arg: string | undefined;
      if (tpl[k] === "{") { const end = tpl.indexOf("}", k); if (end !== -1) { arg = tpl.slice(k + 1, end); k = end + 1; } }
      top().push({ t: "ph", name, arg });
      i = k;
    } else { top().push({ t: "lit", v: c }); i++; }
  }
  return root;
}

function fmtDate(d: Date, fmt: string): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()), YY: String(d.getFullYear()).slice(-2),
    MM: p2(d.getMonth() + 1), M: String(d.getMonth() + 1),
    DD: p2(d.getDate()), D: String(d.getDate()),
    HH: p2(d.getHours()), mm: p2(d.getMinutes()), ss: p2(d.getSeconds()),
  };
  return fmt.replace(/YYYY|YY|MM|M|DD|D|HH|mm|ss/g, (m) => map[m]);
}

function evalPh(name: string, arg: string | undefined, ctx: RenderContext): string {
  switch (name) {
    case "creator": return ctx.creator;
    case "creatorId": return ctx.creatorId;
    case "postTitle": return ctx.postTitle;
    case "postId": return ctx.postId;
    case "date": return fmtDate(ctx.postedAt, arg ?? "YYYYMMDD");
    case "today": return fmtDate(ctx.now, arg ?? "YYYYMMDD");
    case "contentTitle": return ctx.contentTitle;
    case "contentId": return ctx.contentId;
    case "contentType": return ctx.contentType;
    case "plan": return ctx.plan;
    case "filename": return ctx.filename;
    case "ext": return ctx.ext;
    case "total": return String(ctx.total);
    case "seq": {
      if (ctx.total <= 1) return "";
      const n = arg ? Number(arg) : 0;
      return Number.isFinite(n) && n > 0 ? String(ctx.seq).padStart(n, "0") : String(ctx.seq);
    }
    default: throw new TemplateError(`unknown placeholder: \$${name}`);
  }
}

function render(nodes: Node[], ctx: RenderContext): { text: string; hadPh: boolean; anyEmpty: boolean } {
  let text = ""; let hadPh = false; let anyEmpty = false;
  for (const n of nodes) {
    if (n.t === "lit") text += n.v;
    else if (n.t === "ph") { const v = evalPh(n.name, n.arg, ctx); hadPh = true; if (v === "") anyEmpty = true; text += v; }
    else {
      const r = render(n.children, ctx);
      hadPh = hadPh || r.hadPh; anyEmpty = anyEmpty || r.anyEmpty;
      if (!(r.hadPh && r.anyEmpty)) text += r.text;
    }
  }
  return { text, hadPh, anyEmpty };
}

export function renderTemplate(
  template: string,
  ctx: RenderContext,
  opts: { replacement: string; segmentMaxLen: number }
): string {
  const raw = render(parse(template), ctx).text;
  const segs = raw.split("/");
  return segs
    .map((s, idx) => sanitizeSegment(s, { replacement: opts.replacement, maxLen: opts.segmentMaxLen, preserveExt: idx === segs.length - 1 }))
    .join("/");
}
