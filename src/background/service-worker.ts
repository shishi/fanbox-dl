// service-worker.ts: 薄い束縛のみ。SW ロジック本体は orchestrator.ts。
import { loadSettings } from "../core/settings";
import { createOrchestrator } from "./orchestrator";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, handleZipDownloadChange, reconcileZipDownloads } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";

const orchestrator = createOrchestrator({
  downloads: {
    download: (opts) => chrome.downloads.download(opts),
    search: (q) => chrome.downloads.search(q),
    erase: (q) => chrome.downloads.erase(q),
    removeFile: (id) => chrome.downloads.removeFile(id),
  },
  loadSettings,
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

chrome.downloads.onChanged.addListener(async (delta) => {
  if (await handleZipDownloadChange(delta)) return; // zip 由来
  await orchestrator.handleDownloadChanged(delta);
});

// 起動時: zip blob URL の revoke 用復元 + redirect map 復元(通常 DL の resume は無い)
(async () => {
  await reconcileZipDownloads();
  await orchestrator.loadRedirectMap();
})().catch((e) => console.error("[fanbox-dl] startup failed:", e));
