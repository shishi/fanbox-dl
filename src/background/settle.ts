import { findAdoptable } from "./adoption";
import { applyDownloadStarted, applyDownloadComplete, applyDownloadInterrupted, applyDownloadRequestFailed } from "./ledger";
import { classifyDownloadError } from "./failure-classifier";
import { validateMediaUrl } from "../core/url-allowlist";
import type { JobStore } from "./job-store";

export interface SettleDeps {
  store: JobStore;
  inFlight: Map<string, Promise<void>>; // leaseToken -> 進行中の download() 呼び出し
  search: (q: { url?: string; id?: number }) => Promise<Array<{ id: number; url?: string; finalUrl?: string; filename: string; startTime?: string; state?: string; error?: string }>>;
  cancel: (id: number) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  // 最終レビュー修正2: promise 喪失 + adoption が interrupted を見つけた際、reconcile の
  // crash-window interrupted 分岐と同じ即時分類(applyDownloadInterrupted)に newLeaseToken が要る。
  // 既存呼び出し元/テストを壊さないよう省略可能にし、未指定時は内部フォールバックを使う。
  newLeaseToken?: () => string;
}

const fallbackLeaseToken = (): string => `settle-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// spec §7c-3: force の前処理。対象投稿の非 terminal ジョブをすべて「解決済み」にする。
// lease 未解決(downloadId 未永続)のままの requeue は禁止 — promise 待ち、または
// adoption 検索(terminal は採用・進行中は cancel・ヒットなしは CAS で error 化)で必ず決着させる。
export async function settleInFlight(postId: string, deps: SettleDeps): Promise<string[]> {
  const errors: string[] = [];
  const newLeaseToken = deps.newLeaseToken ?? fallbackLeaseToken;
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
          items.map((d) => ({ id: d.id, url: d.url ?? "", filename: d.filename, startTime: d.startTime ?? "", state: d.state, error: d.error })),
          { url: rec.url, relPath: rec.relPath, leasedAt: rec.leasedAt ?? 0 },
        );
        if (hit && hit.state === "complete") {
          // 最終レビュー修正2 Fix B: adoption 述語は URL/パス/時刻だけで採用するため、
          // redirect 済みかどうかは未確認。採用前に hit.id で実体を再取得し、finalUrl を
          // allowlist で再検証してから done 化する(reconcile の finalizeComplete と同じ契約)。
          const [full] = await deps.search({ id: hit.id });
          // codex レビュー指摘(最終レビュー修正2 round2): 実体再取得(id 指定)が history
          // clear 等のレースで空を返す場合、hit.url(検証済みの元 request URL であって
          // 「検証済み finalUrl」ではない)へフォールバックすると、finalizeComplete が
          // 閉じたのと同じ redirect bypass の穴を settle 側で再び開けてしまう。
          // fail-closed: full(または full.finalUrl/full.url)が無ければ done にしない。
          const finalUrl = full?.finalUrl ?? full?.url;
          const v = finalUrl ? validateMediaUrl(finalUrl, rec.postId) : { ok: false as const, error: "実体を再取得できません" };
          if (!v.ok) {
            const message = finalUrl ? "ダウンロードが許可外 URL にリダイレクトされました" : "完了を確認できませんでした(finalUrl 未確認)";
            await deps.store.commit((l) => ({
              ledger: applyDownloadInterrupted(applyDownloadStarted(l, rec.idemKey, token, hit.id), rec.idemKey, token, "terminal_error", message, newLeaseToken, deps.now()),
              result: null,
            }));
            continue;
          }
          // terminal は採用してから進む(成果を捨てない)
          await deps.store.commit((l) => ({ ledger: applyDownloadComplete(applyDownloadStarted(l, rec.idemKey, token, hit.id), rec.idemKey, token, full?.filename ?? hit.filename, deps.now()), result: null }));
          continue;
        }
        if (hit && hit.state === "interrupted") {
          // reconcile の crash-window interrupted 分岐と同じ扱い: 「requested + terminal 待機」
          // にせず、その場で classify して確定する(採用 = 実体は既に停止済みで待っても terminal
          // 到達イベントは来ない — 待てば必ずタイムアウトする無駄な 10 秒を避ける)。
          const [d] = await deps.search({ id: hit.id });
          if (d) {
            const reason = d.error ?? "interrupted";
            const classified = classifyDownloadError(reason === "interrupted" ? undefined : reason);
            // settle は force 前処理として「非 terminal を残さない」契約(spec §7c-3)。
            // retry_once(NETWORK_ の有界リトライ)は onChanged/reconcile のような
            // 実際に download() を再度蹴れる文脈でのみ安全 — settle にはその手段が無いため、
            // ここで pending に戻すと「settleInFlight は成功したのに誰も再開しない」ジョブが
            // 残る(codex レビュー指摘 P2)。この文脈では必ず terminal に倒す
            // (どのみち直後の force enqueue が新しい世代で download() をやり直す)。
            const action = classified === "retry_once" ? "terminal_error" : classified;
            await deps.store.commit((l) => ({
              ledger: applyDownloadInterrupted(applyDownloadStarted(l, rec.idemKey, token, hit.id), rec.idemKey, token, action, reason, newLeaseToken, deps.now()),
              result: null,
            }));
            continue;
          }
          // 2 回目の search(id 指定)が history clear 等のレースで空を返す場合
          // (codex レビュー指摘 P2 round2): reason(SERVER_FORBIDDEN 等)を確定できないまま
          // 汎用の "interrupted" に丸めて terminal_error にすると、refusedUrl(同一 URL の
          // 自動再投入禁止)を刻めず、拒否済み URL を無駄に再投入してしまう。
          // ここでは continue せず下の一般経路(cancel + 有界待機)へフォールバックし、
          // 解決できなければタイムアウトエラーとして可視化する(fail-closed)。
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
