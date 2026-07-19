// Offscreen Document (MV3)。
//
// Service Worker には DOM が無く URL.createObjectURL が使えないため、
// zip の Blob 化 + object URL 発行だけをこの常駐ページで行う。
// service worker から chrome.runtime.sendMessage で転送される base64 チャンクを
// jobId ごとに蓄積し、"zipDone" を受け取ったら Blob を組み立てて URL を返す。
import { base64ToBytes } from "../core/base64";
import { OFFSCREEN_TARGET } from "./protocol";
import type { OffscreenMessage, OffscreenResult } from "./protocol";

// jobId をキーにした蓄積バッファ。offscreen document は破棄されない限り
// 状態を保持し続けるページなので、モジュールスコープの Map で足りる。
const accumulators = new Map<string, Uint8Array<ArrayBuffer>[]>();

chrome.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, sendResponse) => {
  if (!msg || msg.target !== OFFSCREEN_TARGET) return false; // 無関係なメッセージは無視

  if (msg.kind === "zipChunk") {
    const list = accumulators.get(msg.jobId) ?? [];
    list.push(base64ToBytes(msg.base64));
    accumulators.set(msg.jobId, list);
    return false; // fire-and-forget、応答不要
  }

  if (msg.kind === "zipDone") {
    // 同じ jobId の使い回しで前回分が残っていても混ざらないよう、読んだら即 delete する。
    const chunks = accumulators.get(msg.jobId);
    accumulators.delete(msg.jobId);
    if (!chunks) {
      sendResponse({ ok: false, error: `unknown jobId: ${msg.jobId}` } satisfies OffscreenResult);
      return true;
    }
    try {
      const blob = new Blob(chunks, { type: msg.mimeType });
      const url = URL.createObjectURL(blob);
      sendResponse({ ok: true, url } satisfies OffscreenResult);
    } catch (e) {
      sendResponse({ ok: false, error: String(e) } satisfies OffscreenResult);
    }
    return true;
  }

  if (msg.kind === "zipAbort") {
    // content-script がタブクローズ/エラー等で "end" を送らずに切断したケース。
    // 蓄積済みチャンクを放置すると offscreen document は常駐なのでメモリリークになるため破棄する。
    accumulators.delete(msg.jobId);
    return false;
  }

  if (msg.kind === "revoke") {
    URL.revokeObjectURL(msg.url);
    return false;
  }

  return false;
});
