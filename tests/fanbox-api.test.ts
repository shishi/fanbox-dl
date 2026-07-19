import { describe, it, expect } from "vitest";
import { fetchPostInfo, validatePostInfo } from "../src/fanbox/api";

const res = (status: number, body: any) => ({ status, ok: status === 200, json: async () => body });
const noSleep = async () => {};

describe("fetchPostInfo", () => {
  it("200 なら json を返す", async () => {
    const r = await fetchPostInfo("1", { fetchFn: async () => res(200, { body: { post: { id: "1", type: "image" } } }), sleep: noSleep });
    expect(r.ok).toBe(true);
  });
  it("429 は 1 回だけリトライして成功できる", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => (++n === 1 ? res(429, null) : res(200, { body: { post: { id: "1", type: "image" } } })), sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });
  it("429 が 2 回続いたら明示エラー(リトライは 1 回まで)", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => { n++; return res(429, null); }, sleep: noSleep });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("時間を置いて");
    expect(n).toBe(2);
  });
  it("ネットワーク例外もリトライ対象", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => { if (++n === 1) throw new Error("net"); return res(200, { body: { post: { id: "1", type: "image" } } }); }, sleep: noSleep });
    expect(r.ok).toBe(true);
  });
  it("403 等はリトライせず即エラー", async () => {
    let n = 0;
    const r = await fetchPostInfo("1", { fetchFn: async () => { n++; return res(403, null); }, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
  });
});

describe("validatePostInfo (spec §4a schema 検証)", () => {
  it("id 一致 + type 既知形状で null", () => {
    expect(validatePostInfo({ body: { post: { id: "5", type: "article", isRestricted: false, body: { blocks: [], imageMap: {}, fileMap: {}, embedMap: {}, urlEmbedMap: {} } } } }, "5")).toBeNull();
  });
  it("article は embedMap / urlEmbedMap を欠くと既知の形ではない (spec §4)", () => {
    expect(validatePostInfo({ body: { post: { id: "5", type: "article", isRestricted: false, body: { blocks: [], imageMap: {}, fileMap: {} } } } }, "5")).not.toBeNull();
  });
  it("body:null は isRestricted によらず schema を通す (spec §6: parse が restricted 扱いにして『アクセス権なし』を通知する契約)", () => {
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: false, body: null } } }, "5")).toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: true, body: null } } }, "5")).toBeNull();
  });
  it("postId 不一致はエラー", () => {
    expect(validatePostInfo({ body: { post: { id: "6", type: "image" } } }, "5")).toContain("一致しない");
  });
  it("構造が壊れていたらエラー", () => {
    expect(validatePostInfo({}, "5")).not.toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5" } } }, "5")).not.toBeNull();
  });
  it("既知 type の body 形状も検証する (spec §4a 既知の形)", () => {
    // image なのに images が配列でない / article なのに blocks が無い -> エラー
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: false, body: { images: "x" } } } }, "5")).not.toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5", type: "file", isRestricted: false, body: {} } } }, "5")).not.toBeNull();
    expect(validatePostInfo({ body: { post: { id: "5", type: "article", isRestricted: false, body: { blocks: [], imageMap: null, fileMap: {}, embedMap: {}, urlEmbedMap: {} } } } }, "5")).not.toBeNull();
    // 正常形は OK
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: false, body: { images: [] } } } }, "5")).toBeNull();
    // 制限付き(body null)は OK(親の isRestricted で判定される)
    expect(validatePostInfo({ body: { post: { id: "5", type: "image", isRestricted: true, body: null } } }, "5")).toBeNull();
    // 未知 type は schema ではエラーにしない(spec §2: parse が空を返しスキップ+通知)
    expect(validatePostInfo({ body: { post: { id: "5", type: "mystery", isRestricted: false, body: {} } } }, "5")).toBeNull();
  });
});
