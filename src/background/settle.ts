import { findAdoptable } from "./adoption";
import { applyDownloadStarted, applyDownloadComplete, applyDownloadRequestFailed } from "./ledger";
import type { JobStore } from "./job-store";

export interface SettleDeps {
  store: JobStore;
  inFlight: Map<string, Promise<void>>; // leaseToken -> 進行中の download() 呼び出し
  search: (q: { url?: string; id?: number }) => Promise<Array<{ id: number; url?: string; filename: string; startTime?: string; state?: string }>>;
  cancel: (id: number) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

// spec §7c-3: force の前処理。対象投稿の非 terminal ジョブをすべて「解決済み」にする。
// lease 未解決(downloadId 未永続)のままの requeue は禁止 — promise 待ち、または
// adoption 検索(terminal は採用・進行中は cancel・ヒットなしは CAS で error 化)で必ず決着させる。
export async function settleInFlight(postId: string, deps: SettleDeps): Promise<string[]> {
  const errors: string[] = [];
  const snapshot = await deps.store.read();
  for (const rec of Object.values(snapshot.jobs)) {
    if (rec.postId !== postId) continue;
    if (rec.state !== "pending" && rec.state !== "requested") continue;
    const token = rec.leaseToken;
    if (!token) continue;

    if (rec.downloadId === undefined) {
      const p = deps.inFlight.get(token);
      if (p) {
        await p; // (a) 生きた promise はその解決を待つ
      } else {
        // (b) promise 喪失: adoption 述語で browser 側の実体を探す
        const items = await deps.search({ url: rec.url });
        const hit = findAdoptable(
          items.map((d) => ({ id: d.id, url: d.url ?? "", filename: d.filename, startTime: d.startTime ?? "", state: d.state })),
          { url: rec.url, relPath: rec.relPath, leasedAt: rec.leasedAt ?? 0 },
        );
        if (hit && hit.state === "complete") {
          // terminal は採用してから進む(成果を捨てない)
          await deps.store.commit((l) => ({ ledger: applyDownloadComplete(applyDownloadStarted(l, rec.idemKey, token, hit.id), rec.idemKey, token, hit.filename, deps.now()), result: null }));
          continue;
        }
        if (hit) {
          await deps.store.commit((l) => ({ ledger: applyDownloadStarted(l, rec.idemKey, token, hit.id), result: null }));
          try { await deps.cancel(hit.id); } catch {}
        } else {
          // browser 側に実体なし = download() は発火しなかった。CAS で決着させる
          await deps.store.commit((l) => ({ ledger: applyDownloadRequestFailed(l, rec.idemKey, token, "lease 未解決(ダウンロード実体なし)"), result: null }));
          continue;
        }
      }
    }

    // downloadId が付いた進行中を cancel -> terminal 遷移の有界待機(onChanged が ledger を進める)
    const cur1 = (await deps.store.read()).jobs[rec.idemKey];
    if (cur1 && (cur1.state === "pending" || cur1.state === "requested") && cur1.downloadId !== undefined) {
      try { await deps.cancel(cur1.downloadId); } catch {}
      const deadline = deps.now() + 10_000;
      for (;;) {
        const cur = (await deps.store.read()).jobs[rec.idemKey];
        if (!cur || cur.state === "done" || cur.state === "error" || cur.state === "needs_page") break;
        if (deps.now() >= deadline) { errors.push(`${rec.relPath}: 進行中ダウンロードの停止がタイムアウトしました`); break; }
        await deps.sleep(200);
      }
    }
  }
  return errors;
}
