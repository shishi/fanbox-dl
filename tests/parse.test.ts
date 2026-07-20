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

describe("parsePost", () => {
  it("image 投稿: 1 photo ブロックに images[] 順で格納", () => {
    const p = parsePost(wrap({ ...base, type: "image", body: { text: "", images: [img("a"), img("b")] } }));
    expect(p.postId).toBe("111");
    expect(p.fee).toBe(500);
    expect(p.contents).toHaveLength(1);
    const b = p.contents[0];
    expect(b.blockOrdinal).toBe(1);
    expect(b.contentType).toBe("photo");
    expect(b.files.map(f => f.contentType)).toEqual(["photo", "photo"]);
    expect(b.files[0].seq).toBe(1);
    expect(b.files[0].total).toBe(2);
    expect(b.files[0].filename).toBe("a"); // image は URL basename(ハッシュ)
    expect(b.files[0].url).toContain("/images/post/111/a.jpeg");
    expect(b.files[1].url).toContain("/images/post/111/b.jpeg");
  });

  it("file 投稿: 拡張子で video/file を判定", () => {
    const p = parsePost(wrap({ ...base, type: "file", body: { text: "", files: [fil("f1", "movie", "mp4"), fil("f2", "doc", "pdf")] } }));
    expect(p.contents).toHaveLength(1);
    const files = p.contents[0].files;
    expect(files[0].contentType).toBe("video");
    expect(files[1].contentType).toBe("file");
    expect(files[0].filename).toBe("movie");
    expect(files[0].url).toContain("/files/post/111/f1.mp4");
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
    expect(p.contents[0].files.map(f => f.url)).toEqual([img("a").originalUrl, img("b").originalUrl]);
    expect(p.contents[2].files.map(f => f.url)).toEqual([img("c").originalUrl]);
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
    // url が重複しない(同じ image が 2 回 DL キューに乗らない)
    const urls = all.map(f => f.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toEqual([img("a").originalUrl, img("b").originalUrl]);
    expect(all[1].seq).toBe(2);
    expect(all[1].total).toBe(2); // スキップ後のユニーク列に対して振る
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
    expect(all).toHaveLength(2);
    expect(all[0].contentType).toBe("photo");
    expect(all[0].url).toBe(img("same").originalUrl);
    expect(all[1].contentType).toBe("file");
    expect(all[1].url).toBe(fil("same", "n", "zip").url);
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
