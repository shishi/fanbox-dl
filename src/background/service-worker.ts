// service-worker.ts: 薄い束縛のみ。SW ロジック本体は orchestrator.ts。
import { loadSettings } from "../core/settings";
import { createOrchestrator } from "./orchestrator";
import { filenameGuard } from "./filename-guard";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, handleZipDownloadChange, reconcileZipDownloads } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";

const orchestrator = createOrchestrator({
  downloads: {
    download: (opts) => chrome.downloads.download(opts),
    search: (q) => chrome.downloads.search(q),
    erase: (q) => chrome.downloads.erase(q),
    removeFile: (id) => chrome.downloads.removeFile(id),
    cancel: (id) => chrome.downloads.cancel(id),
  },
  loadSettings,
  filenameGuard,
  zip: { eligible: zipEligible, collect: collectZipSources, build: buildZip, downloadViaOffscreen: downloadZipViaOffscreen },
  now: () => Date.now(),
  session: {
    get: (k) => chrome.storage.session.get(k),
    set: (items) => chrome.storage.session.set(items),
  },
  log: (m) => console.error(m),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "download") {
    orchestrator.handleDownloadRequest(msg as DownloadRequestMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ queued: 0, zipQueued: 0, notices: [], errors: [String(e)] } satisfies DownloadResponse));
    return true;
  }
  return false;
});

// 横取り対策: download({filename}) の filename は提案でしかなく、
// downloads.onDeterminingFilename を登録した拡張が居ると捨てられる。ここで
// 自分の DL のテンプレ名を言い直す(効き方の前提と、効かないときに疑う先は
// filename-guard.ts の冒頭コメントに書いてある)。
// MV3 なのでトップレベルで同期的に登録する(遅延登録だと SW が寝ている間の
// イベントでこの SW が起こされず、他拡張の決定がそのまま通る)。
// suggest() を呼ぶのは claim 済み URL = 自分が発行した DL だけ。それ以外は
// 何も返さず他拡張の決定に干渉しない(戻り値 true は「suggest を非同期で呼ぶ」
// の意味なので、同期 suggest のここでは返さない)。
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  filenameGuard.handleDeterminingFilename(item, suggest);
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (await handleZipDownloadChange(delta)) return; // zip 由来
  await orchestrator.handleDownloadChanged(delta);
});

// 起動時: zip blob URL の revoke 用復元 + redirect map 復元(通常 DL の resume は無い)
(async () => {
  await reconcileZipDownloads();
  await orchestrator.loadRedirectMap();
})().catch((e) => console.error("[fanbox-dl] startup failed:", e));
