import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { zipEligible, collectZipSources, buildZip, ZIP_SOURCE_BUDGET_BYTES, ZIP_MAX_FILES, registerZipDownload, handleZipDownloadChange } from "../src/background/zip";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import type { ContentBlock, FileItem } from "../src/core/types";

const item = (id: string): FileItem => ({
  contentType: "photo", url: `https://downloads.fanbox.cc/images/post/1/${id}.jpg`,
  filename: id, ext: "jpg", seq: 1, total: 1, idemKey: `1:image:${id}`,
  stableContentId: `image:${id}`, refetch: { postId: "1", stableContentId: `image:${id}`, index: 0 },
});
const block = (n: number): ContentBlock => ({
  blockOrdinal: 1, contentType: "photo",
  files: Array.from({ length: n }, (_, i) => item(`f${i}`)),
});

describe("zipEligible (spec §7b)", () => {
  it("photo かつ 2 枚以上かつ zipGalleries ON で true", () => {
    expect(zipEligible(block(2), DEFAULT_SETTINGS)).toBe(true);
  });
  it("単発 photo は false(個別 DL の耐久性を優先)", () => {
    expect(zipEligible(block(1), DEFAULT_SETTINGS)).toBe(false);
  });
  it("zipGalleries OFF / photo フィルタ OFF で false", () => {
    expect(zipEligible(block(2), { ...DEFAULT_SETTINGS, zipGalleries: false })).toBe(false);
    expect(zipEligible(block(2), { ...DEFAULT_SETTINGS, contentTypes: { ...DEFAULT_SETTINGS.contentTypes, photo: false } })).toBe(false);
  });
  it("file ブロックは false", () => {
    expect(zipEligible({ ...block(2), contentType: "file" }, DEFAULT_SETTINGS)).toBe(false);
  });
});

describe("collectZipSources (spec §7b バジェット)", () => {
  // chunkSizes を順に流すモック。abort されたら以降のチャンクを出さない
  const chunked = (chunkSizes: number[], status = 200) => {
    const state = { aborted: false, yielded: 0 };
    const resp = {
      ok: status === 200, status,
      async *chunks() {
        for (const n of chunkSizes) {
          if (state.aborted) return;
          state.yielded += n;
          yield new Uint8Array(n);
        }
      },
      abort: () => { state.aborted = true; },
    };
    return { resp, state };
  };
  it("直列 fetch して buffers を返す", async () => {
    const r = await collectZipSources(block(2).files, "1", { fetchFn: async () => chunked([10]).resp });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.buffers.size).toBe(2);
  });
  it("累積バイトが budget を超えた時点で abort して中止 error(読み切らない) (spec §7b)", async () => {
    const states: Array<{ aborted: boolean; yielded: number }> = [];
    const r = await collectZipSources(block(1).files, "1", {
      fetchFn: async () => { const { resp, state } = chunked([60, 60, 60]); states.push(state); return resp; },
      budget: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("上限");
    // 2 チャンク目(累積 120 > 100)で中止し、3 チャンク目は受信していない
    expect(states[0].yielded).toBe(120);
    expect(states[0].aborted).toBe(true);
  });
  it("事前チェック: 既知サイズ合計が budget 超過なら 1 バイトも fetch せず error (spec §7b(a))", async () => {
    let called = 0;
    const files = block(2).files.map((f, i) => ({ ...f, size: 80 }));
    const r = await collectZipSources(files, "1", { fetchFn: async () => { called++; return chunked([1]).resp; }, budget: 100 });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });

  it("件数上限超過は fetch せず即 error", async () => {
    let called = 0;
    const files = Array.from({ length: ZIP_MAX_FILES + 1 }, (_, i) => item(`f${i}`));
    const r = await collectZipSources(files, "1", { fetchFn: async () => { called++; return chunked([1]).resp; } });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });
  it("allowlist 違反 URL は fetch せず error (spec §4a: zip ソース fetch も対象)", async () => {
    const bad = { ...item("x"), url: "https://evil.example.com/images/post/1/x.jpg" };
    const r = await collectZipSources([bad], "1", { fetchFn: async () => chunked([1]).resp });
    expect(r.ok).toBe(false);
  });
  it("fetch 失敗(403 等)は error", async () => {
    const r = await collectZipSources(block(2).files, "1", { fetchFn: async () => chunked([], 403).resp });
    expect(r.ok).toBe(false);
  });
  it("既定 budget は 100MB", () => {
    expect(ZIP_SOURCE_BUDGET_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe("buildZip (spec §7b 黙った欠落の禁止)", () => {
  const post = {
    postId: "1", postTitle: "T", creator: "C", creatorId: "s", fee: 0,
    publishedAt: new Date("2026-07-01T00:00:00Z"), updatedAtIso: "", restricted: false,
    postType: "image", skippedEmbeds: 0, contents: [],
  } as any;
  it("ソース buffer が欠けていたら throw(呼び出し側の個別 DL フォールバックに乗せる)", () => {
    const b = block(2);
    const buffers = new Map([[b.files[0].idemKey, new Uint8Array(1)]]); // 2 本目が欠落
    expect(() => buildZip(post, b, buffers, DEFAULT_SETTINGS, new Date())).toThrow(/欠落/);
  });
  it("エントリ名衝突は ' (n)' 連番で回避される(静かな上書き禁止)", () => {
    const b = block(2);
    // $seq を含まないテンプレで両ファイルが同名になる状況を作る
    const s = { ...DEFAULT_SETTINGS, zipEntryTemplate: "$filename.$ext" };
    b.files = b.files.map((f) => ({ ...f, filename: "same" }));
    const buffers = new Map(b.files.map((f) => [f.idemKey, new Uint8Array(1)]));
    const { bytes } = buildZip(post, b, buffers, s, new Date());
    // fantia-dl と同一の " (n)" 規則をエントリ名で直接検証する
    const entries = Object.keys(unzipSync(bytes));
    expect(entries.sort()).toEqual(["same (2).jpg", "same.jpg"]);
  });
});

describe("handleZipDownloadChange (spec §7b 途中失敗の配達経路)", () => {
  it("登録済み zip DL の interrupted は revoke + 必須文言の console ログ", async () => {
    const revoked: string[] = [];
    const logs: string[] = [];
    const deps = { revoke: async (u: string) => { revoked.push(u); }, log: (m: string) => { logs.push(m); }, persist: async () => {} };
    registerZipDownload(42, "blob:xyz", deps);
    const handled = await handleZipDownloadChange({ id: 42, state: { current: "interrupted", previous: "in_progress" } } as any, deps);
    expect(handled).toBe(true);
    expect(revoked).toEqual(["blob:xyz"]);
    expect(logs.some((m) => m.includes("zip は最初からやり直し"))).toBe(true);
  });
  it("complete は revoke のみでエラーログを出さない", async () => {
    const revoked: string[] = [];
    const logs: string[] = [];
    const deps = { revoke: async (u: string) => { revoked.push(u); }, log: (m: string) => { logs.push(m); }, persist: async () => {} };
    registerZipDownload(43, "blob:ok", deps);
    const handled = await handleZipDownloadChange({ id: 43, state: { current: "complete", previous: "in_progress" } } as any, deps);
    expect(handled).toBe(true);
    expect(revoked).toEqual(["blob:ok"]);
    expect(logs).toEqual([]);
  });
  it("未登録の downloadId は false(通常 DL の onChanged 処理へ)", async () => {
    expect(await handleZipDownloadChange({ id: 999, state: { current: "complete", previous: "x" } } as any, { revoke: async () => {}, log: () => {}, persist: async () => {} })).toBe(false);
  });
});
