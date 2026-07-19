// src/options/options.ts
import { loadSettings, saveSettings, CONFLICT_ACTION } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import type { RenderContext, Settings } from "../core/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const singleSample: RenderContext = {
  creator: "sample_creator", creatorId: "1234", postTitle: "サンプル投稿", postId: "1234567",
  postedAt: new Date("2026-01-15T12:30:00+09:00"), now: new Date(),
  contentTitle: "", contentId: "42", contentType: "photo", plan: "0",
  filename: "image", ext: "png", seq: 2, total: 4,
};

const zipPathSample: RenderContext = {
  ...singleSample,
  filename: "gallery", ext: "zip", seq: 1, total: 1,
};

const zipEntrySample: RenderContext = { ...singleSample };

let cur: Settings;

function renderPreview(tpl: string, ctx: RenderContext, previewEl: string, errEl: string) {
  try {
    const rel = renderTemplate(tpl, ctx, {
      replacement: ($("repl") as HTMLInputElement).value || "_",
      segmentMaxLen: cur.segmentMaxLen,
    });
    const v = validatePath(rel, {
      fullPathMaxLen: cur.fullPathMaxLen,
      uniquifyHeadroom: cur.uniquifyHeadroom,
      conflictAction: CONFLICT_ACTION,
      segmentMaxLen: cur.segmentMaxLen,
    });
    $(previewEl).textContent = rel;
    $(errEl).textContent = v.ok ? "" : `検証エラー: ${v.error}`;
  } catch (e) {
    $(previewEl).textContent = "";
    $(errEl).textContent = e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e);
  }
}

function updateAllPreviews() {
  renderPreview(($("tpl") as HTMLInputElement).value, singleSample, "preview", "tplErr");
  renderPreview(($("zip_path_tpl") as HTMLInputElement).value, zipPathSample, "zip_path_preview", "zipPathErr");
  renderPreview(($("zip_entry_tpl") as HTMLInputElement).value, zipEntrySample, "zip_entry_preview", "zipEntryErr");
}

async function init() {
  cur = await loadSettings();
  ($("tpl") as HTMLInputElement).value = cur.pathTemplate;
  ($("zip_path_tpl") as HTMLInputElement).value = cur.zipPathTemplate;
  ($("zip_entry_tpl") as HTMLInputElement).value = cur.zipEntryTemplate;
  ($("repl") as HTMLInputElement).value = cur.illegalCharReplacement;
  ($("ct_photo") as HTMLInputElement).checked = cur.contentTypes.photo;
  ($("ct_file") as HTMLInputElement).checked = cur.contentTypes.file;
  ($("ct_video") as HTMLInputElement).checked = cur.contentTypes.video;
  ($("zip_galleries") as HTMLInputElement).checked = cur.zipGalleries;

  ["tpl", "zip_path_tpl", "zip_entry_tpl", "repl"].forEach((id) =>
    $(id).addEventListener("input", updateAllPreviews),
  );
  updateAllPreviews();

  $("save").addEventListener("click", async () => {
    cur = {
      ...cur,
      pathTemplate: ($("tpl") as HTMLInputElement).value,
      zipPathTemplate: ($("zip_path_tpl") as HTMLInputElement).value,
      zipEntryTemplate: ($("zip_entry_tpl") as HTMLInputElement).value,
      illegalCharReplacement: ($("repl") as HTMLInputElement).value || "_",
      contentTypes: {
        photo: ($("ct_photo") as HTMLInputElement).checked,
        file: ($("ct_file") as HTMLInputElement).checked,
        video: ($("ct_video") as HTMLInputElement).checked,
      },
      zipGalleries: ($("zip_galleries") as HTMLInputElement).checked,
    };
    await saveSettings(cur);
    $("saved").textContent = "保存しました";
    setTimeout(() => ($("saved").textContent = ""), 2000);
  });

  $("clearHistory").addEventListener("click", async () => {
    if (!confirm("DL 履歴を全部クリアしますか?(同じ投稿を再度クリックすると再ダウンロードされるようになります)")) return;
    const btn = $("clearHistory") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ kind: "clearHistory" });
      if (res?.ok) {
        $("clearedNotice").textContent = "履歴をクリアしました";
      } else {
        $("clearedNotice").textContent = `エラー: ${res?.error ?? "不明"}`;
      }
      setTimeout(() => { ($("clearedNotice") as HTMLElement).textContent = ""; }, 3000);
    } finally {
      btn.disabled = false;
    }
  });
}

init();
