import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  pathTemplate: "fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle/[$seq{3}_]$filename.$ext",
  illegalCharReplacement: "_",
  conflictAction: "uniquify",
  contentTypes: { photo: true, file: true, video: true },
  segmentMaxLen: 200,
  fullPathMaxLen: 180,
  uniquifyHeadroom: 16,
  zipGalleries: true,
  zipPathTemplate: "fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle.zip",
  zipEntryTemplate: "[$seq{3}_]$filename.$ext",
};

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    contentTypes: { ...DEFAULT_SETTINGS.contentTypes, ...(s.contentTypes ?? {}) },
  };
}

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get("settings");
  return mergeSettings(raw?.settings as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings: s });
}
