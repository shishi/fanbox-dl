### Task 4: fanbox/parse.ts(TDD・spec §6)

**Files:**
- Create: `src/fanbox/parse.ts`
- Test: `tests/parse.test.ts`

**Interfaces:**
- Consumes: `PostData / ContentBlock / FileItem / ContentType`(Task 3)
- Produces: `parsePost(json: any): PostData` — post.info レスポンス(`{body:{post:{...}}}` の `post` 部分ではなく **json 全体**を受け取る)
- Produces: `emptyPostNotice(postType: string): string` — DL 対象が無い投稿の type 別通知文言
  (spec §2 の区別: text=「対象なし」/ video=「外部埋め込みのため対象外」/ 未知=「未対応タイプのためスキップ」/ それ以外=汎用)。SW(Task 15)が使う

**グルーピング規則**(spec §6 に明文化済み): article の blocks 走査では**メディアブロック(image/file)以外(p 等)はグループを切らない**。グループはメディア種が変わったときだけ切り替わる(image 群→file 群)。

- [ ] **Step 1: 失敗テストを書く**

`tests/parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parsePost, emptyPostNotice } from "../src/fanbox/parse";

// PoC(spec §4)で実測した構造のフィクスチャ
const base = {
  id: "111", title: "T", feeRequired: 500,
  publishedDatetime: "2026-07-01T12:00:00+09:00",
  updatedDatetime: "2026-07-02T12:00:00+09:00",
  isRestricted: false,
  user: { userId: "9", name: "Creator" }, creatorId: "slug",
};
const wrap = (post: any) => ({ body: { post } });
const img = (id: string, ext = "jpeg") => ({
  id, extension: ext, width: 100, height: 100,
  originalUrl: `https://downloads.fanbox.cc/images/post/111/${id}.${ext}`,
  thumbnailUrl: `https://downloads.fanbox.cc/images/post/111/t_${id}.${ext}`,
});
const fil = (id: string, name: string, ext: string) => ({
  id, name, extension: ext, size: 10,
  url: `https://downloads.fanbox.cc/files/post/111/${id}.${ext}`,
});
// (file 投稿のテストで size が FileItem.size に保持されることも assert する:
//  expect(files[0].size).toBe(10) を file 投稿テストに追加)

describe("parsePost", () => {
  it("image 投稿: 1 photo ブロックに images[] 順で格納、identity は image:{id}", () => {
    const p = parsePost(wrap({ ...base, type: "image", body: { text: "", images: [img("a"), img("b")] } }));
    expect(p.postId).toBe("111");
    expect(p.fee).toBe(500);
    expect(p.updatedAtIso).toBe("2026-07-02T12:00:00+09:00");
    expect(p.contents).toHaveLength(1);
    const b = p.contents[0];
    expect(b.blockOrdinal).toBe(1);
    expect(b.contentType).toBe("photo");
    expect(b.files.map(f => f.stableContentId)).toEqual(["image:a", "image:b"]);
    expect(b.files.map(f => f.idemKey)).toEqual(["111:image:a", "111:image:b"]);
    expect(b.files[0].seq).toBe(1);
    expect(b.files[0].total).toBe(2);
    expect(b.files[0].filename).toBe("a"); // image は URL basename(ハッシュ)
    expect(b.files[0].url).toContain("/images/post/111/a.jpeg");
    expect(b.files[0].refetch).toEqual({ postId: "111", stableContentId: "image:a", index: 0 });
  });

  it("file 投稿: 拡張子で video/file を判定", () => {
    const p = parsePost(wrap({ ...base, type: "file", body: { text: "", files: [fil("f1", "movie", "mp4"), fil("f2", "doc", "pdf")] } }));
    expect(p.contents).toHaveLength(1);
    const files = p.contents[0].files;
    expect(files[0].contentType).toBe("video");
    expect(files[1].contentType).toBe("file");
    expect(files[0].filename).toBe("movie");
    expect(files[0].stableContentId).toBe("file:f1");
    expect(files[0].size).toBe(10); // zip 事前サイズチェック用に保持(spec §7b)
  });

  it("article: p を跨いだ連続 image はひとつの photo ブロックに集約、file で切り替わる", () => {
    const p = parsePost(wrap({
      ...base, type: "article",
      body: {
        blocks: [
          { type: "p", text: "hi" },
          { type: "image", imageId: "a" },
          { type: "p", text: "mid" },
          { type: "image", imageId: "b" },
          { type: "file", fileId: "f1" },
          { type: "image", imageId: "c" },
        ],
        imageMap: { a: img("a"), b: img("b"), c: img("c") },
        fileMap: { f1: fil("f1", "attach", "zip") },
        embedMap: {}, urlEmbedMap: {},
      },
    }));
    expect(p.contents.map(b => b.contentType)).toEqual(["photo", "file", "photo"]);
    expect(p.contents.map(b => b.blockOrdinal)).toEqual([1, 2, 3]);
    expect(p.contents[0].files.map(f => f.stableContentId)).toEqual(["image:a", "image:b"]);
    expect(p.contents[2].files.map(f => f.stableContentId)).toEqual(["image:c"]);
    // refetch.index は投稿全体のパース順(ブロックごとにリセットしない。spec §6)
    expect(p.contents.flatMap(b => b.files).map(f => f.refetch.index)).toEqual([0, 1, 2, 3]);
  });

  it("必須フィクスチャ1: 同じ imageId の非連続 2 回出現は初出のみ採用 (spec §14-1)", () => {
    const p = parsePost(wrap({
      ...base, type: "article",
      body: {
        blocks: [
          { type: "image", imageId: "a" },
          { type: "image", imageId: "b" },
          { type: "p", text: "x" },
          { type: "image", imageId: "a" }, // 重複
        ],
        imageMap: { a: img("a"), b: img("b") }, fileMap: {}, embedMap: {}, urlEmbedMap: {},
      },
    }));
    const all = p.contents.flatMap(b => b.files);
    expect(all.map(f => f.stableContentId)).toEqual(["image:a", "image:b"]);
    expect(all[1].seq).toBe(2);
    expect(all[1].total).toBe(2); // スキップ後のユニーク列に対して振る
    const keys = all.map(f => f.idemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("必須フィクスチャ1b: imageId と fileId が同一文字列でも別ジョブとして共存 (spec §14-1b)", () => {
    const p = parsePost(wrap({
      ...base, type: "article",
      body: {
        blocks: [{ type: "image", imageId: "same" }, { type: "file", fileId: "same" }],
        imageMap: { same: img("same") }, fileMap: { same: fil("same", "n", "zip") },
        embedMap: {}, urlEmbedMap: {},
      },
    }));
    const all = p.contents.flatMap(b => b.files);
    expect(all.map(f => f.idemKey)).toEqual(["111:image:same", "111:file:same"]);
  });

  it("制限付き投稿(body null)は contents 空 + restricted", () => {
    const p = parsePost(wrap({ ...base, isRestricted: true, type: "image", body: null }));
    expect(p.restricted).toBe(true);
    expect(p.contents).toEqual([]);
  });

  it("isRestricted:false でも body:null なら restricted 扱い (spec §6: 『または』)", () => {
    const p = parsePost(wrap({ ...base, isRestricted: false, type: "image", body: null }));
    expect(p.restricted).toBe(true);
    expect(p.contents).toEqual([]);
  });

  it("text / 未知 type は contents 空", () => {
    expect(parsePost(wrap({ ...base, type: "text", body: { text: "x" } })).contents).toEqual([]);
    expect(parsePost(wrap({ ...base, type: "mystery", body: {} })).contents).toEqual([]);
  });

  it("emptyPostNotice は type 別の通知文言を返す (spec §2)", () => {
    expect(emptyPostNotice("text")).toContain("DL 対象はありません");
    expect(emptyPostNotice("video")).toContain("外部埋め込み");
    expect(emptyPostNotice("mystery")).toContain("未対応");
    expect(emptyPostNotice("image")).toContain("DL 対象はありません"); // 空ギャラリー等の汎用
  });

  it("embed/url_embed ブロックは skippedEmbeds に数えられる (spec §2 通知のみ)", () => {
    const p = parsePost(wrap({
      ...base, type: "article",
      body: {
        blocks: [{ type: "image", imageId: "a" }, { type: "embed", embedId: "e1" }, { type: "url_embed", urlEmbedId: "u1" }],
        imageMap: { a: img("a") }, fileMap: {}, embedMap: {}, urlEmbedMap: {},
      },
    }));
    expect(p.skippedEmbeds).toBe(2);
    expect(p.contents).toHaveLength(1); // embed はグループを切らない
  });

  it("imageMap に実体が無い image block はスキップ(壊れたデータで throw しない)", () => {
    const p = parsePost(wrap({
      ...base, type: "article",
      body: { blocks: [{ type: "image", imageId: "ghost" }], imageMap: {}, fileMap: {}, embedMap: {}, urlEmbedMap: {} },
    }));
    expect(p.contents).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -5'
```

Expected: FAIL(`src/fanbox/parse.ts` が無い)

- [ ] **Step 3: 実装**

`src/fanbox/parse.ts`:

```ts
import type { PostData, ContentBlock, FileItem, ContentType } from "../core/types";

const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

function urlBasenameNoExt(url: string): string {
  const path = url.split("?")[0];
  const base = path.substring(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

interface RawImage { id: string; extension: string; originalUrl: string }
interface RawFile { id: string; name: string; extension: string; url: string; size?: number }

function imageToItem(im: RawImage): Omit<FileItem, "seq" | "total"> {
  return {
    contentType: "photo",
    url: im.originalUrl,
    filename: urlBasenameNoExt(im.originalUrl),
    ext: (im.extension || "").toLowerCase(),
    idemKey: "", stableContentId: `image:${im.id}`,
    refetch: { postId: "", stableContentId: `image:${im.id}`, index: 0 },
  };
}

function fileToItem(f: RawFile): Omit<FileItem, "seq" | "total"> {
  const ext = (f.extension || "").toLowerCase();
  return {
    contentType: VIDEO_EXT.has(ext) ? "video" : "file",
    url: f.url,
    filename: f.name ?? null,
    ext,
    size: typeof f.size === "number" ? f.size : undefined,
    idemKey: "", stableContentId: `file:${f.id}`,
    refetch: { postId: "", stableContentId: `file:${f.id}`, index: 0 },
  };
}

// spec §2: DL 対象が無い投稿の type 別通知文言(text=対象なし / video=対象外(通知のみ) /
// 未知=スキップ+通知)。SW が contents 空のとき使う。
const KNOWN_TYPES = new Set(["image", "file", "article", "text", "video"]);
export function emptyPostNotice(postType: string): string {
  if (postType === "video") return "外部埋め込み動画の投稿のため DL 対象外です";
  if (!KNOWN_TYPES.has(postType)) return `未対応の投稿タイプ(${postType})のためスキップしました`;
  return `この投稿(type: ${postType})に DL 対象はありません`;
}

export function parsePost(json: any): PostData {
  const post = json?.body?.post ?? {};
  const postId = String(post.id ?? "");
  const restricted = post.isRestricted === true || post.body == null;

  const data: PostData = {
    postId,
    postTitle: post.title ?? "",
    creator: post.user?.name ?? "",
    creatorId: post.creatorId ?? "",
    fee: typeof post.feeRequired === "number" ? post.feeRequired : 0,
    publishedAt: new Date(post.publishedDatetime ?? 0),
    updatedAtIso: post.updatedDatetime ?? "",
    restricted,
    postType: post.type ?? "",
    skippedEmbeds: 0,
    contents: [],
  };
  if (restricted) return data;

  const b = post.body;
  // group: メディアの並び。image/file 以外のブロックはグループを切らない
  // (p で切るとギャラリーが全部単発になり zip が成立しないため。plan で確定した解釈)。
  const groups: { kind: "image" | "file"; items: Array<Omit<FileItem, "seq" | "total">> }[] = [];
  const seen = { image: new Set<string>(), file: new Set<string>() };
  const push = (kind: "image" | "file", item: Omit<FileItem, "seq" | "total">, rawId: string) => {
    if (seen[kind].has(rawId)) return; // 初出のみ採用(spec §6 重複スキップ・名前空間ごと)
    seen[kind].add(rawId);
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.items.push(item);
    else groups.push({ kind, items: [item] });
  };

  if (post.type === "image") {
    for (const im of b.images ?? []) push("image", imageToItem(im), String(im.id));
  } else if (post.type === "file") {
    for (const f of b.files ?? []) push("file", fileToItem(f), String(f.id));
  } else if (post.type === "article") {
    for (const blk of b.blocks ?? []) {
      if (blk?.type === "image") {
        const im = b.imageMap?.[blk.imageId];
        if (im) push("image", imageToItem(im), String(im.id));
      } else if (blk?.type === "file") {
        const f = b.fileMap?.[blk.fileId];
        if (f) push("file", fileToItem(f), String(f.id));
      } else if (blk?.type === "embed" || blk?.type === "url_embed" || blk?.type === "video") {
        data.skippedEmbeds++; // spec §2: 対象外だが通知は出す(SW 側で notices 化)
      }
      // p / 見出し等の非メディアブロックは無視(グループも切らない)
    }
  }
  // text / video(外部埋め込み) / 未知 type は groups 空のまま

  let ordinal = 0;
  let parseIndex = 0; // spec §6: refetch.index は投稿全体のパース順(整合性チェック専用)
  for (const g of groups) {
    ordinal++;
    const files: FileItem[] = g.items.map((it, i) => ({
      ...it,
      seq: i + 1,
      total: g.items.length,
      idemKey: `${postId}:${it.stableContentId}`,
      refetch: { postId, stableContentId: it.stableContentId, index: parseIndex++ },
    }));
    const block: ContentBlock = {
      blockOrdinal: ordinal,
      contentType: g.kind === "image" ? "photo" : "file",
      files,
    };
    data.contents.push(block);
  }
  return data;
}
```

- [ ] **Step 4: テスト green を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck'
```

Expected: 全 PASS

- [ ] **Step 5: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "feat: fanbox post.info parser with stable-id identity" -m "spec §6: image/file/article の 3 type を PostData に正規化。article は p を跨いで同種メディアを集約し、名前空間別の初出のみ採用で idemKey 衝突を構造的に排除する。"'
```

---

