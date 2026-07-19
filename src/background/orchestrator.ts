import { CONFLICT_ACTION } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { validateMediaUrl } from "../core/url-allowlist";
import { parsePost, emptyPostNotice } from "../fanbox/parse";
import { validatePostInfo } from "../fanbox/api";
import { buildRenderContext } from "./render-adapter";
import { classifyDownloadError } from "./failure-classifier";
import { findAdoptable } from "./adoption";
import {
  applyEnqueue, applyDownloadStarted, applyDownloadRequestFailed, applyDownloadComplete,
  applyDownloadInterrupted, applyNeedsPageRecovery, applyPruneSweep,
  findLeasesWithoutDownloadId, applyReissueLease, applyInvalidateByIds,
  type EnqueueCandidate, type JobRecord, type Ledger,
} from "./ledger";
import { JobStore, StorageWriteError } from "./job-store";
import { settleInFlight } from "./settle";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, ZIP_FALLBACK_WORDING, ZIP_RETRY_WORDING } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";
import type { Settings } from "../core/types";

export interface OrchestratorDeps {
  store: JobStore;
  downloads: {
    download(opts: chrome.downloads.DownloadOptions): Promise<number>;
    search(q: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
    cancel(id: number): Promise<void>;
  };
  loadSettings: () => Promise<Settings>;
  // 注: post.info fetch は content script が担うため fetchPost dep は無い(spec §4a)。
  //     handleDownloadRequest は message で渡された json を検証して使う。
  zip: {
    eligible: typeof zipEligible;
    collect: typeof collectZipSources;
    build: typeof buildZip;
    downloadViaOffscreen: typeof downloadZipViaOffscreen;
  };
  now: () => number;
  newLeaseToken: () => string;
}

export function createOrchestrator(deps: OrchestratorDeps): {
  handleDownloadRequest(msg: DownloadRequestMessage): Promise<DownloadResponse>;
  handleDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void>;
  runStartupReconcile(): Promise<void>;
} {
  const { store, newLeaseToken } = deps;
  // force の lease 解決待ち用: leaseToken -> 進行中の download() 呼び出し(spec §7c-3(a))
  const inFlightDownloads = new Map<string, Promise<void>>();

  const mkValidatePath = (s: Settings) => (relPath: string): string | null => {
    const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
    return v.ok ? null : v.error;
  };

  // spec §4a-3(緩和): complete 到達時は必ず最終 URL を allowlist で再検証する(redirect 対策)。
  // handleDownloadChanged の実 DL complete 経路と、runStartupReconcile の 2 つの complete
  // 経路(crash-window adoption / requested reconcile)は、どれも同じ純粋変換をここに集約する。
  function finalizeComplete(
    l: Ledger, rec: JobRecord, token: string,
    item: { finalUrl?: string; url?: string; filename?: string } | undefined,
    now: number,
  ): Ledger {
    const finalUrl = item?.finalUrl || item?.url || rec.url;
    if (!validateMediaUrl(finalUrl, rec.postId).ok) {
      return applyDownloadInterrupted(l, rec.idemKey, token, "terminal_error", "ダウンロードが許可外 URL にリダイレクトされました", newLeaseToken, now);
    }
    return applyDownloadComplete(l, rec.idemKey, token, item?.filename ?? "", now);
  }

  // download() はキューの外で呼ぶ(spec §7c-2 デッドロック防止)。結果反映は短いキュー項目。
  function startDownload(rec: JobRecord): Promise<void> {
    const token = rec.leaseToken!;
    const p = (async () => {
      // spec §4a: allowlist はあらゆるネットワーク使用の直前に必ず通す。
      // retry / resume / reissue は永続化済み URL を使うため、ここでの再検証が最後の砦。
      const v = validateMediaUrl(rec.url, rec.postId);
      if (!v.ok) {
        await store.commit((l) => ({ ledger: applyDownloadRequestFailed(l, rec.idemKey, token, `allowlist 違反: ${v.error}`, deps.now()), result: null }));
        inFlightDownloads.delete(token);
        return;
      }
      try {
        const downloadId = await deps.downloads.download({
          url: rec.url, filename: rec.relPath, saveAs: false, conflictAction: CONFLICT_ACTION,
        });
        await store.commit((l) => ({ ledger: applyDownloadStarted(l, rec.idemKey, token, downloadId), result: null }));
      } catch (e) {
        await store.commit((l) => ({ ledger: applyDownloadRequestFailed(l, rec.idemKey, token, String(e)), result: null }));
      } finally {
        inFlightDownloads.delete(token);
      }
    })();
    inFlightDownloads.set(token, p);
    return p;
  }

  // force 前処理は settle.ts(spec §7c-3。ユニットテスト済み)を使う
  const settleDeps = {
    store, inFlight: inFlightDownloads,
    search: (q: { url?: string; id?: number }) => deps.downloads.search(q),
    cancel: (id: number) => deps.downloads.cancel(id),
    now: deps.now,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    newLeaseToken,
  };

  async function handleDownloadRequest(msg: DownloadRequestMessage): Promise<DownloadResponse> {
    const res: DownloadResponse = { queued: 0, zipQueued: 0, notices: [], errors: [] };
    // startDownload() はキューの外の fire-and-forget だが、呼び出し元(content script)へは
    // 「requested まで進んだ」状態を返したいので、応答直前にここへ集めて待ち合わせる
    // (queue.run 自体はブロックしないため spec §7c-2 デッドロック防止とは独立)。
    const pending: Promise<void>[] = [];
    const finish = async (): Promise<DownloadResponse> => { await Promise.all(pending); return res; };
    if (store.failClosed) {
      res.errors.push("ストレージ書き込みに失敗しました。履歴をクリアするまで DL 機能を停止します");
      return finish();
    }

    // spec §4a: post.info は content script が isolated world で fetch 済み。
    // SW は受領 json を検証してから使う(生データを信用しない)。
    const schemaErr = validatePostInfo(msg.json, msg.postId);
    if (schemaErr) { res.errors.push(schemaErr); return finish(); }

    const post = parsePost(msg.json);
    if (post.restricted) { res.notices.push("アクセス権がないためダウンロードできません(未加入プランの投稿、または本文を取得できない投稿)"); return finish(); }
    // spec §2「対象外・通知のみ」: embed 通知を先に出し、embed だけの投稿は
    // 汎用「DL 対象なし」を重ねない(通知のみの扱い)
    if (post.skippedEmbeds > 0) {
      res.notices.push(`埋め込みコンテンツ ${post.skippedEmbeds} 件は DL 対象外です`);
    }
    if (post.contents.length === 0) {
      if (post.skippedEmbeds === 0) res.notices.push(emptyPostNotice(post.postType));
      return finish();
    }

    const s = await deps.loadSettings();
    const now = new Date(deps.now());
    const vp = mkValidatePath(s);

    // 前回までの明示エラーをクリック時に可視化する(静かな失敗の禁止。spec §7a)
    {
      const cur = await store.read();
      const prevErrors = Object.values(cur.jobs).filter((j) => j.postId === post.postId && j.state === "error");
      if (prevErrors.length > 0) {
        res.notices.push(`前回までに ${prevErrors.length} 件が失敗しています: ${prevErrors.slice(0, 3).map((j) => j.error).join(" / ")}`);
      }
    }

    // 全メディア URL の allowlist(spec §4a: あらゆるネットワーク使用の前)
    const invalidIds = new Set<string>();
    for (const b of post.contents) {
      b.files = b.files.filter((f) => {
        const v = validateMediaUrl(f.url, post.postId);
        if (!v.ok) { res.errors.push(v.error); invalidIds.add(f.stableContentId); }
        return v.ok;
      });
    }

    // spec §7c-3: force はまず対象投稿の非 terminal ジョブをすべて決着させる
    // (needs_page 回復や enqueue で新しい非 terminal を作る前に行う — 順序は normative)
    if (msg.force) {
      const errs = await settleInFlight(post.postId, settleDeps);
      res.errors.push(...errs);
      if (errs.length) return finish(); // lease 未解決のままの requeue は禁止(spec §7c-3)
    }

    // spec §4a: allowlist 違反 ID の既存ジョブ(進行中/needs_page)を error 化し、
    // 進行中だったものは実 DL も cancel する
    if (invalidIds.size > 0) {
      const before = await store.read();
      const toCancel = Object.values(before.jobs)
        .filter((j) => j.postId === post.postId && invalidIds.has(j.stableContentId) && j.downloadId !== undefined && (j.state === "pending" || j.state === "requested"))
        .map((j) => j.downloadId!);
      const inv = await store.commit((l) => {
        const r = applyInvalidateByIds(l, post.postId, invalidIds, deps.now());
        return { ledger: r.ledger, result: r.invalidated };
      });
      for (const id of toCancel) { try { await deps.downloads.cancel(id); } catch {} }
      for (const k of inv) res.errors.push(`${k}: メディア URL が許可外のためダウンロードできません`);
    }

    // needs_page 回復(spec §6): この投稿の needs_page レコードを安定 ID で再バインド
    const fresh = post.contents.flatMap((b) => b.files.map((f) => ({
      stableContentId: f.stableContentId, url: f.url,
      basePath: renderTemplate(s.pathTemplate, buildRenderContext(post, b, f, now), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen }),
    })));
    try {
      const rec = await store.commit((l) => {
        const r = applyNeedsPageRecovery(l, post.postId, fresh, { now: deps.now(), postUpdatedAt: post.updatedAtIso, newLeaseToken, validatePath: vp, invalidIds });
        return { ledger: r.ledger, result: r };
      });
      for (const j of rec.toStart) { pending.push(startDownload(j)); res.queued++; }
      for (const k of rec.missing) res.errors.push(`${k}: 投稿が編集され該当ファイルは存在しません`);
      for (const k of rec.refused) res.errors.push(`${k}: 同じ URL のままサーバ側の失敗が続いています。時間を置いて再試行してください`);
      for (const k of rec.invalid) res.errors.push(`${k}: メディア URL が許可外のためダウンロードできません`);
      res.errors.push(...rec.errors);
    } catch (e) {
      if (e instanceof StorageWriteError) { res.errors.push(e.message); return finish(); }
      throw e;
    }

    // ブロックごとに zip か個別かを決め、candidates を組み立てる
    const candidates: EnqueueCandidate[] = [];
    for (const b of post.contents) {
      let zipDone = false;
      if (deps.zip.eligible(b, s)) {
        const collected = await deps.zip.collect(b.files.map((f) => ({ url: f.url, idemKey: f.idemKey, size: f.size })), post.postId, {});
        if (collected.ok) {
          try {
            const { zipPath, bytes } = deps.zip.build(post, b, collected.buffers, s, now);
            const pv = vp(zipPath);
            if (pv) throw new Error(`${zipPath}: ${pv}`);
            const dl = await deps.zip.downloadViaOffscreen(zipPath, bytes);
            if (dl.ok) { res.zipQueued++; zipDone = true; }
            else res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${dl.error}`);
          } catch (e) {
            res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${e instanceof TemplateError ? e.message : String(e)}`);
          }
        } else {
          res.notices.push(`${ZIP_FALLBACK_WORDING}(${ZIP_RETRY_WORDING}): ${collected.error}`);
        }
      }
      if (zipDone) continue; // spec §7b: zip 成立ブロックは個別 enqueue しない
      for (const f of b.files) {
        if (!(s.contentTypes as any)[f.contentType]) continue;
        let basePath: string;
        try {
          basePath = renderTemplate(s.pathTemplate, buildRenderContext(post, b, f, now), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
        } catch (e) {
          res.errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
          return finish(); // テンプレ不正は全体中断(fantia-dl と同じ契約)
        }
        candidates.push({
          idemKey: f.idemKey, postId: post.postId, stableContentId: f.stableContentId,
          contentType: f.contentType, url: f.url, basePath, refetch: f.refetch,
        });
      }
    }

    try {
      const r = await store.commit((l) => {
        const out = applyEnqueue(l, candidates, {
          force: msg.force, postUpdatedAt: post.updatedAtIso, now: deps.now(),
          newLeaseToken, validatePath: vp,
        });
        return { ledger: out.ledger, result: out };
      });
      res.errors.push(...r.errors);
      for (const k of r.inFlightBlocked) res.notices.push(`${k}: 進行中のダウンロードがあります。作り直すには再DLボタンを`);
      for (const k of r.staleWarnings) res.notices.push(`${k}: 投稿は更新されていますが、このファイルの URL は変わっていません。差し替えを確実に取り込むには 🔄(再DL)を使ってください`);
      for (const j of r.toStart) { pending.push(startDownload(j)); res.queued++; }
    } catch (e) {
      if (e instanceof StorageWriteError) { res.errors.push(e.message); return finish(); }
      throw e;
    }
    return finish();
  }

  async function handleDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    if (!delta.state) return;
    const cur = delta.state.current;
    if (cur !== "complete" && cur !== "interrupted") return;

    const ledger = await store.read();
    const rec = Object.values(ledger.jobs).find((j) => j.downloadId === delta.id);
    if (!rec || !rec.leaseToken) return;
    const token = rec.leaseToken;

    if (cur === "complete") {
      // spec §7c-2: 実保存パスを取得して乖離を判定
      const [item] = await deps.downloads.search({ id: delta.id });
      // spec §4a-3(緩和): 最終 URL が allowlist を抜けていたら done にせず error 化(redirect 対策)
      await store.commit((l) => ({ ledger: finalizeComplete(l, rec, token, item, deps.now()), result: null }));
      return;
    }
    const [item] = await deps.downloads.search({ id: delta.id });
    // classify と ledger 記録は同一の解決済み reason を使う(SERVER_FORBIDDEN の明示文言と
    // refusedUrl 刻印が、reason の取得元の違いで欠けないように)
    const reason = delta.error?.current ?? item?.error ?? "interrupted";
    const action = classifyDownloadError(reason === "interrupted" ? undefined : reason);
    const after = await store.commit((l) => {
      const l2 = applyDownloadInterrupted(l, rec.idemKey, token, action, reason, newLeaseToken, deps.now());
      return { ledger: l2, result: l2.jobs[rec.idemKey] };
    });
    if (after && after.state === "pending") void startDownload(after); // NETWORK_ の有界リトライ
  }

  async function runStartupReconcile(): Promise<void> {
    // spec §7c-2 フェイルクローズの再起動耐性: failClosed はメモリフラグなので、
    // 起動のたびに「現 ledger をそのまま書き戻す」プローブ commit で書き込み可否を再検出する。
    // 失敗したら failClosed が立ち(JobStore.commit 内)、resume を含む DL 機能を停止する。
    try {
      await store.commit((l) => ({ ledger: l, result: null }));
    } catch {
      console.error("[fanbox-dl] storage write probe failed — DL 機能を停止します(履歴クリアで復旧)");
      return; // reconcile も行わない(帳簿を進められないため)
    }
    const ledger = await store.read();

    // lease 済み・downloadId 未永続(crash window): adoption 述語で引き取り、ダメなら再投入
    for (const rec of findLeasesWithoutDownloadId(ledger)) {
      const items = await deps.downloads.search({ url: rec.url });
      const hit = findAdoptable(
        items.map((d) => ({ id: d.id, url: d.url ?? "", filename: d.filename, startTime: d.startTime ?? "", state: d.state })),
        { url: rec.url, relPath: rec.relPath, leasedAt: rec.leasedAt ?? 0 },
      );
      if (hit) {
        await store.commit((l) => ({ ledger: applyDownloadStarted(l, rec.idemKey, rec.leaseToken!, hit.id), result: null }));
        if (hit.state === "complete") {
          // spec §4a-3(緩和): ここも handleDownloadChanged と同じ finalUrl 再検証を通す
          // (採用述語は URL/パス/時刻だけで adopt するため、redirect 済みかどうかは未確認)。
          const [d] = await deps.downloads.search({ id: hit.id });
          if (d) {
            await store.commit((l) => ({ ledger: finalizeComplete(l, rec, rec.leaseToken!, d, deps.now()), result: null }));
          } else {
            // 2 回目の search が history clear 等のレースで空を返す場合(codex レビュー指摘
            // P3 round2): hit.url(常に allowlist 内 = 検証済み request URL)を finalUrl の
            // 代わりに使うと、redirect bypass チェックをすり抜けさせてしまう
            // (hit.url は「検証済み finalUrl」ではなく単なる元 URL)。fail-closed で
            // error に倒し、done と誤認させない。
            await store.commit((l) => ({
              ledger: applyDownloadInterrupted(l, rec.idemKey, rec.leaseToken!, "terminal_error", "ダウンロード完了を確認できませんでした(実体を再取得できません)", newLeaseToken, deps.now()),
              result: null,
            }));
          }
        } else if (hit.state === "interrupted") {
          // 採用した実体が既に interrupted の場合、ここで分類まで済ませないと
          // 「requested のまま enqueue をブロックし続ける」wedge になる
          const [d] = await deps.downloads.search({ id: hit.id });
          const reason = d?.error ?? "interrupted";
          const action = classifyDownloadError(reason === "interrupted" ? undefined : reason);
          const after = await store.commit((l) => {
            const l2 = applyDownloadInterrupted(l, rec.idemKey, rec.leaseToken!, action, reason, newLeaseToken, deps.now());
            return { ledger: l2, result: l2.jobs[rec.idemKey] };
          });
          if (after && after.state === "pending") void startDownload(after);
        }
        // in_progress は onChanged の terminal 到達に任せる
      } else {
        // spec §7c-2: requeue は lease を再発行してから(旧 lease の遅延解決を CAS で殺すため)
        const reissued = await store.commit((l) => {
          const r = applyReissueLease(l, rec.idemKey, rec.leaseToken!, newLeaseToken(), deps.now());
          return { ledger: r.ledger, result: r.record };
        });
        if (reissued) void startDownload(reissued); // 最悪ケースは uniquify の重複 1 個(spec §7c-1)
      }
    }

    // requested: downloadId の実状態と突き合わせ
    // (crash-window ループが ledger を進めた可能性があるため必ず再読込する — stale snapshot 禁止)
    const ledger2 = await store.read();
    for (const rec of Object.values(ledger2.jobs)) {
      if (rec.state !== "requested" || rec.downloadId === undefined || !rec.leaseToken) continue;
      const [d] = await deps.downloads.search({ id: rec.downloadId });
      if (!d) {
        const reissued = await store.commit((l) => {
          const r = applyReissueLease(l, rec.idemKey, rec.leaseToken!, newLeaseToken(), deps.now());
          return { ledger: r.ledger, result: r.record };
        });
        if (reissued) void startDownload(reissued);
        continue;
      }
      if (d.state === "complete") {
        // spec §4a-3(緩和): 再検証は d(検索結果の実 DownloadItem)の finalUrl でそのまま行える
        await store.commit((l) => ({ ledger: finalizeComplete(l, rec, rec.leaseToken!, d, deps.now()), result: null }));
      } else if (d.state === "interrupted") {
        const reason = d.error ?? "interrupted";
        const action = classifyDownloadError(reason === "interrupted" ? undefined : reason);
        const after = await store.commit((l) => {
          const l2 = applyDownloadInterrupted(l, rec.idemKey, rec.leaseToken!, action, reason, newLeaseToken, deps.now());
          return { ledger: l2, result: l2.jobs[rec.idemKey] };
        });
        if (after && after.state === "pending") void startDownload(after);
      }
    }

    // prune / sweep(spec §7c-2)
    await store.commit((l) => ({ ledger: applyPruneSweep(l, deps.now()), result: null }));
  }

  return { handleDownloadRequest, handleDownloadChanged, runStartupReconcile };
}
