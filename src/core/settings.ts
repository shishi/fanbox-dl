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
