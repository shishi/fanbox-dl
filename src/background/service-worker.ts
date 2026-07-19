// service-worker.ts: 薄い束縛のみ。SW ロジック本体は orchestrator.ts(deps 注入ファクトリ)。
import { loadSettings } from "../core/settings";
import { applyClearTerminal } from "./ledger";
import { JobStore } from "./job-store";
import { createOrchestrator } from "./orchestrator";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, handleZipDownloadChange, reconcileZipDownloads } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";

const store = new JobStore();

const orchestrator = createOrchestrator({
  store,
  downloads: {
    download: (opts) => chrome.downloads.download(opts),
    search: (q) => chrome.downloads.search(q),
    cancel: (id) => chrome.downloads.cancel(id),
  },
  loadSettings,
  zip: {
    eligible: zipEligible,
    collect: collectZipSources,
    build: buildZip,
    downloadViaOffscreen: downloadZipViaOffscreen,
  },
  now: () => Date.now(),
  newLeaseToken: () => crypto.randomUUID(),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "download") {
    orchestrator.handleDownloadRequest(msg as DownloadRequestMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ queued: 0, zipQueued: 0, notices: [], errors: [String(e)] } satisfies DownloadResponse));
    return true;
  }
  if (msg?.kind === "clearHistory") {
    store.commit((l) => ({ ledger: applyClearTerminal(l, Date.now()), result: null }))
      .then(() => { store.failClosed = false; sendResponse({ ok: true }); })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (await handleZipDownloadChange(delta)) return; // zip 由来(job-store 対象外)
  await orchestrator.handleDownloadChanged(delta);
});

// 起動時 reconcile(spec §7c-1 / fantia-dl 同等)
(async () => {
  await reconcileZipDownloads();
  await orchestrator.runStartupReconcile();
})().catch((e) => console.error("[fanbox-dl] reconcile failed:", e));
