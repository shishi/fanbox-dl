### Task 3: types.ts / settings.ts の fanbox 改修

**Files:**
- Modify: `src/core/types.ts`(全面書き換え)
- Modify: `src/core/settings.ts`(全面書き換え)
- Modify: `tests/settings.test.ts`(conflictAction 撤去に合わせて書き換え)

**Interfaces:**
- Consumes: なし(型定義)
- Produces(以降の全タスクが import する):
  - `ContentType = "photo" | "file" | "video"`
  - `FileItem { contentType, url, filename, ext, size?: number, seq, total, idemKey, stableContentId, refetch: {postId, stableContentId, index} }`(size は file item のみ API が返す。zip の事前サイズチェックに使う)
  - `ContentBlock { blockOrdinal: number, contentType, files: FileItem[] }`
  - `PostData { postId, postTitle, creator, creatorId, fee: number, publishedAt: Date, updatedAtIso: string, restricted: boolean, postType: string, skippedEmbeds: number, contents: ContentBlock[] }`
  - `RenderContext`(**fantia-dl と完全同一** — core template-engine が読むため無改造)
  - `Settings`(conflictAction なし)+ `DEFAULT_SETTINGS` + `mergeSettings` + `CONFLICT_ACTION = "uniquify" as const`

- [ ] **Step 1: settings の失敗テストを書く**

`tests/settings.test.ts` を以下で全面置き換え:

```ts
import { describe, it, expect } from "vitest";
import { mergeSettings, DEFAULT_SETTINGS, CONFLICT_ACTION } from "../src/core/settings";

describe("mergeSettings (fanbox)", () => {
  it("undefined なら既定値を返す", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it("部分指定は既定値にマージされる", () => {
    const s = mergeSettings({ pathTemplate: "x/$postId" });
    expect(s.pathTemplate).toBe("x/$postId");
    expect(s.zipGalleries).toBe(true);
  });
  it("contentTypes は deep merge", () => {
    const s = mergeSettings({ contentTypes: { photo: false } as any });
    expect(s.contentTypes).toEqual({ photo: false, file: true, video: true });
  });
  it("保存済みの conflictAction(旧値・不正値)は無視され、結果に含まれない (spec §14)", () => {
    const s = mergeSettings({ conflictAction: "overwrite" } as any);
    expect((s as any).conflictAction).toBeUndefined();
  });
  it("未知キーは持ち込まれない", () => {
    const s = mergeSettings({ evil: 1 } as any);
    expect((s as any).evil).toBeUndefined();
  });
  it("CONFLICT_ACTION 定数は uniquify", () => {
    expect(CONFLICT_ACTION).toBe("uniquify");
  });
  it("既定テンプレートが fanbox 用", () => {
    expect(DEFAULT_SETTINGS.pathTemplate).toBe("fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/[$seq{3}_]$filename.$ext");
    expect(DEFAULT_SETTINGS.zipPathTemplate).toBe("fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/images_$contentId.zip");
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | tail -20'
```

Expected: settings.test.ts が FAIL(CONFLICT_ACTION 未定義など)

- [ ] **Step 3: types.ts を書く**

`src/core/types.ts` 全面置き換え:

```ts
// src/core/types.ts
export type ContentType = "photo" | "file" | "video";

// identity(stableContentId)とテンプレ用ブロック番号(blockOrdinal)は
// 型レベルで分離する(spec §6 構造的分離)。どちらも string/number だが、
// contentId という名前は render adapter の出力(RenderContext)にしか現れない。
export interface FileItem {
  contentType: ContentType;
  url: string;               // downloads.fanbox.cc の直 URL(署名なし・期限なし)
  filename: string | null;   // file: name(人間可読・拡張子なし) / image: URL basename(ハッシュ)
  ext: string;               // 拡張子(ドットなし)。API の extension を正とする
  size?: number;             // file item のみ API が返す(zip 事前サイズチェック用 spec §7b)
  seq: number;               // ブロック内 1-based(重複スキップ後の連番)
  total: number;             // ブロック内総数(重複スキップ後)
  idemKey: string;           // "postId:stableContentId"
  stableContentId: string;   // "image:{id}" | "file:{id}"(imageMap/fileMap は別名前空間)
  refetch: { postId: string; stableContentId: string; index: number };
}

export interface ContentBlock {
  blockOrdinal: number;      // post 内 1-based 通し番号($contentId の値になる。識別子ではない)
  contentType: ContentType;
  files: FileItem[];
}

export interface PostData {
  postId: string;
  postTitle: string;
  creator: string;           // user.name
  creatorId: string;         // creatorId(人間可読スラグ)
  fee: number;               // feeRequired($plan は String(fee))
  publishedAt: Date;         // publishedDatetime
  updatedAtIso: string;      // updatedDatetime(鮮度シグナル。spec §8)
  restricted: boolean;       // isRestricted / body:null
  postType: string;          // "image" | "file" | "article" | "text" | 未知
  skippedEmbeds: number;     // embed/url_embed/未知メディアブロックの件数(spec §2: 対象外・通知のみ)
  contents: ContentBlock[];
}

// core の template-engine が読む型。fantia-dl と完全同一(無改造 core の契約)。
// contentId へは render adapter が blockOrdinal を写す(spec §6)。
export interface RenderContext {
  creator: string; creatorId: string;
  postTitle: string; postId: string;
  postedAt: Date; now: Date;
  contentTitle: string; contentId: string; contentType: string; plan: string;
  filename: string; ext: string;
  seq: number; total: number;
}

// conflictAction は設定として存在しない(spec §8/§14: uniquify 固定)。
export interface Settings {
  pathTemplate: string;
  illegalCharReplacement: string;
  contentTypes: { photo: boolean; file: boolean; video: boolean };
  segmentMaxLen: number;
  fullPathMaxLen: number;
  uniquifyHeadroom: number;
  zipGalleries: boolean;
  zipPathTemplate: string;
  zipEntryTemplate: string;
}
```

- [ ] **Step 4: settings.ts を書く**

`src/core/settings.ts` 全面置き換え:

```ts
import type { Settings } from "./types";

// spec §8: 耐久性モデルは uniquify の「無言上書きが構造的に起きない」性質に依存する。
// 設定値ではなく定数。どの保存値もこれを変えられない。
export const CONFLICT_ACTION = "uniquify" as const;

export const DEFAULT_SETTINGS: Settings = {
  pathTemplate: "fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/[$seq{3}_]$filename.$ext",
  illegalCharReplacement: "_",
  contentTypes: { photo: true, file: true, video: true },
  segmentMaxLen: 200,
  fullPathMaxLen: 180,
  uniquifyHeadroom: 16,
  zipGalleries: true,
  zipPathTemplate: "fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/images_$contentId.zip",
  zipEntryTemplate: "[$seq{3}_]$filename.$ext",
};

// 既知キーだけを拾う(旧 conflictAction や未知キーを持ち込まない migration 規則。spec §14)。
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = (stored ?? {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (typeof s.pathTemplate === "string") out.pathTemplate = s.pathTemplate;
  if (typeof s.illegalCharReplacement === "string") out.illegalCharReplacement = s.illegalCharReplacement;
  if (typeof s.segmentMaxLen === "number") out.segmentMaxLen = s.segmentMaxLen;
  if (typeof s.fullPathMaxLen === "number") out.fullPathMaxLen = s.fullPathMaxLen;
  if (typeof s.uniquifyHeadroom === "number") out.uniquifyHeadroom = s.uniquifyHeadroom;
  if (typeof s.zipGalleries === "boolean") out.zipGalleries = s.zipGalleries;
  if (typeof s.zipPathTemplate === "string") out.zipPathTemplate = s.zipPathTemplate;
  if (typeof s.zipEntryTemplate === "string") out.zipEntryTemplate = s.zipEntryTemplate;
  const ct = s.contentTypes as Record<string, unknown> | undefined;
  if (ct) {
    out.contentTypes = {
      photo: typeof ct.photo === "boolean" ? ct.photo : true,
      file: typeof ct.file === "boolean" ? ct.file : true,
      video: typeof ct.video === "boolean" ? ct.video : true,
    };
  }
  return out;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get("settings");
  return mergeSettings(raw?.settings as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings: s });
}
```

- [ ] **Step 5: テストと型チェックを通す**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test && bun run typecheck'
```

Expected: 全 PASS・型エラー 0。core 4 ファイル(template-engine 等)が旧 types の何か(例: RenderContext)を import している場合、RenderContext は同一定義なので通るはず。通らなければ core の import を確認して報告(core は無改造が原則)。

- [ ] **Step 6: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "feat: fanbox domain types and uniquify-only settings" -m "spec §6 の構造的分離(stableContentId / blockOrdinal)を型で強制し、spec §8/§14 に従い conflictAction を設定から撤去(uniquify 定数化・保存済み旧値は既知キー抽出 merge で無害化)。"'
```

---

