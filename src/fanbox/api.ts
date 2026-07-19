// spec §4a: post.info fetch(content script が isolated world で呼ぶ)+ SW 側の schema 検証。
// spec §11: 429/ネットワーク失敗は 5 秒バックオフで 1 回だけリトライ。
export type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; ok: boolean; json(): Promise<any> }>;

const API = "https://api.fanbox.cc/post.info?postId=";
const BACKOFF_MS = 5_000;

export function validatePostInfo(json: any, postId: string): string | null {
  const post = json?.body?.post;
  if (!post || typeof post !== "object") return "post.info の応答構造が不正です";
  if (String(post.id) !== postId) return `応答が要求と一致しない (postId ${post.id} != ${postId})`;
  if (typeof post.type !== "string") return "post.type が不明な形です";
  // spec §4a: 既知 type は body 構造が既知の形であることまで検証(不一致は enqueue しない)。
  // body:null は isRestricted によらず schema を通す — spec §6 が「body:null は空 PostData +
  // 『アクセス権なし』通知」と定めており、その経路は enqueue に到達しないため fail-open ではない。
  // 未知 type は parse 側でスキップ+通知(spec §2)。
  if (post.body == null) return null;
  const b = post.body;
  if (post.type === "image" && !Array.isArray(b.images)) return "image 投稿の body.images が既知の形ではありません";
  if (post.type === "file" && !Array.isArray(b.files)) return "file 投稿の body.files が既知の形ではありません";
  if (post.type === "article") {
    const maps = [b.imageMap, b.fileMap, b.embedMap, b.urlEmbedMap];
    if (!Array.isArray(b.blocks) || maps.some((m) => typeof m !== "object" || m === null)) {
      return "article 投稿の body 構造が既知の形ではありません";
    }
  }
  return null;
}

export async function fetchPostInfo(
  postId: string,
  deps: { fetchFn?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const once = async (): Promise<{ kind: "ok"; json: any } | { kind: "retryable"; error: string } | { kind: "fatal"; error: string }> => {
    let r: Awaited<ReturnType<FetchLike>>;
    try {
      r = await fetchFn(API + encodeURIComponent(postId), { credentials: "include" });
    } catch (e) {
      return { kind: "retryable", error: String(e) };
    }
    if (r.status === 429) return { kind: "retryable", error: "429 (rate limited)" };
    if (!r.ok) return { kind: "fatal", error: `post.info が status ${r.status} を返しました` };
    return { kind: "ok", json: await r.json() };
  };

  const first = await once();
  if (first.kind === "ok") return { ok: true, json: first.json };
  if (first.kind === "fatal") return { ok: false, error: first.error };
  await sleep(BACKOFF_MS);
  const second = await once();
  if (second.kind === "ok") return { ok: true, json: second.json };
  const detail = second.kind === "fatal" ? second.error : second.error;
  return { ok: false, error: `post.info の取得に失敗しました(${detail})。時間を置いて再試行してください` };
}
