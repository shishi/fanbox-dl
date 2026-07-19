import { canonicalRelPath } from "../core/canonical-relpath";
import { pathMatchesBoundary } from "./adoption";
import type { FailureAction } from "./failure-classifier";

// spec §7c-2: 単一キー(`jobs` storage key)に格納する ledger。
// あらゆる状態遷移は「読む -> 純粋変換 -> 1 回 set」で行う(このモジュールは変換のみ)。
export type JobState = "pending" | "requested" | "done" | "error" | "needs_page";

export interface JobRecord {
  idemKey: string;
  postId: string;
  stableContentId: string;
  contentType: string;
  relPath: string;
  url: string;
  generation: number;
  state: JobState;
  leaseToken?: string;
  leasedAt?: number;
  downloadId?: number;
  error?: string;
  doneAt?: number;
  terminalAt?: number;   // 全 terminal 遷移で記録(sweep/cap の順序に使う)
  refusedUrl?: string;   // 回復拒否済み URL(同一 URL の自動再投入禁止)
  actualFilename?: string;
  pathDivergent?: boolean;
  supersededUrl?: string;
  supersededAt?: number;
  pendingPostUpdatedAt?: string;
  lastDownloadedPostUpdatedAt?: string;
  lastWarnedPostUpdatedAt?: string;
  retriedNetwork?: boolean;
  refetch: { postId: string; stableContentId: string; index: number };
}

export interface Ledger {
  jobs: Record<string, JobRecord>;
  generations: Record<string, number>; // tombstone(spec §7c-2 prune 耐性)
}

export function emptyLedger(): Ledger {
  return { jobs: {}, generations: {} };
}

export interface EnqueueCandidate {
  idemKey: string; postId: string; stableContentId: string; contentType: string;
  url: string; basePath: string;
  refetch: { postId: string; stableContentId: string; index: number };
}

export interface EnqueueResult {
  ledger: Ledger;
  toStart: JobRecord[];
  skippedDedup: string[];
  inFlightBlocked: string[];
  staleWarnings: string[];
  errors: string[];
}


// 世代交代スワップ(stale-miss / force / divergent 共通)。同一パスに落ちる場合は
// さらに +1 して .revN の未使用パスへ離脱する(uniquify にパス決定権を渡さない)。
function nextGenerationPath(
  basePath: string, prevGen: number, prevRelPath: string | undefined,
): { generation: number; relPath: string } {
  let gen = prevGen + 1;
  let rel = canonicalRelPath(basePath, gen);
  if (prevRelPath !== undefined && rel === prevRelPath) {
    gen += 1;
    rel = canonicalRelPath(basePath, gen);
  }
  return { generation: gen, relPath: rel };
}

export function applyEnqueue(
  ledger: Ledger,
  candidates: EnqueueCandidate[],
  opts: {
    force: boolean;
    postUpdatedAt: string;
    now: number;
    newLeaseToken: () => string;
    validatePath: (relPath: string) => string | null;
    caps?: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number };
  },
): EnqueueResult {
  const jobs = { ...ledger.jobs };
  const result: EnqueueResult = {
    ledger: { jobs, generations: { ...ledger.generations } },
    toStart: [], skippedDedup: [], inFlightBlocked: [], staleWarnings: [], errors: [],
  };
  const batchPaths = new Set<string>();

  const mint = (cand: EnqueueCandidate, generation: number, relPath: string, prev?: JobRecord): JobRecord => ({
    idemKey: cand.idemKey, postId: cand.postId, stableContentId: cand.stableContentId,
    contentType: cand.contentType, relPath, url: cand.url, generation,
    state: "pending", leaseToken: opts.newLeaseToken(), leasedAt: opts.now,
    pendingPostUpdatedAt: opts.postUpdatedAt,
    supersededUrl: prev?.url, supersededAt: prev?.doneAt,
    lastDownloadedPostUpdatedAt: prev?.lastDownloadedPostUpdatedAt,
    lastWarnedPostUpdatedAt: prev?.lastWarnedPostUpdatedAt,
    refetch: cand.refetch,
  });

  const commitStart = (cand: EnqueueCandidate, rec: JobRecord): void => {
    const err = opts.validatePath(rec.relPath);
    if (err) { result.errors.push(`${rec.relPath}: ${err}`); return; }
    if (batchPaths.has(rec.relPath)) { result.errors.push(`バッチ内パス重複: ${rec.relPath}`); return; }
    batchPaths.add(rec.relPath);
    jobs[cand.idemKey] = rec;
    result.toStart.push(rec);
  };

  for (const cand of candidates) {
    const prev = jobs[cand.idemKey];
    const tombstone = result.ledger.generations[cand.idemKey];

    if (!prev) {
      const gen = tombstone ?? 0;
      commitStart(cand, mint(cand, gen, canonicalRelPath(cand.basePath, gen)));
      continue;
    }

    if (!TERMINAL_STATES.has(prev.state)) {
      // 進行中(spec §7c-2 再入規則)。force はこの関数に来る前に caller が解決済みにする
      // 契約だが、防御的に force でも swap する(cancel 済み前提)。
      if (opts.force) {
        const { generation, relPath } = nextGenerationPath(cand.basePath, prev.generation, prev.relPath);
        commitStart(cand, mint(cand, generation, relPath, prev));
      } else if (prev.url === cand.url && prev.relPath === canonicalRelPath(cand.basePath, prev.generation)) {
        result.skippedDedup.push(cand.idemKey); // 既にキュー済み/実行中
      } else {
        result.inFlightBlocked.push(cand.idemKey);
      }
      continue;
    }

    const dedupOk =
      prev.state === "done" &&
      prev.pathDivergent !== true &&
      prev.url === cand.url &&
      prev.relPath === canonicalRelPath(cand.basePath, prev.generation);

    if (dedupOk && !opts.force) {
      result.skippedDedup.push(cand.idemKey);
      const downloadedAt = prev.lastDownloadedPostUpdatedAt ?? "";
      if (opts.postUpdatedAt > downloadedAt && opts.postUpdatedAt !== prev.lastWarnedPostUpdatedAt) {
        result.staleWarnings.push(cand.idemKey);
        jobs[cand.idemKey] = { ...prev, lastWarnedPostUpdatedAt: opts.postUpdatedAt };
      }
      continue;
    }

    if (prev.state === "done" || opts.force) {
      // stale-miss / divergent / force -> 世代交代スワップ(単一ミューテーション内)
      const { generation, relPath } = nextGenerationPath(cand.basePath, prev.generation, prev.relPath);
      commitStart(cand, mint(cand, generation, relPath, prev));
      continue;
    }

    // error / needs_page の再クリック: 同世代で再 lease して再投入。
    // ただし回復が「サーバ拒否」と判定した URL(refusedUrl)への自動再投入は禁止
    // (spec §7a: 明示エラーに留める。URL が変われば = 編集されれば再投入できる)
    if (prev.state === "error" && prev.refusedUrl === cand.url) {
      result.errors.push(`${cand.idemKey}: サーバがダウンロードを拒否済みです(未加入の有料コンテンツの可能性)`);
      continue;
    }
    const gen = prev.generation;
    commitStart(cand, { ...mint(cand, gen, canonicalRelPath(cand.basePath, gen), prev), supersededUrl: prev.supersededUrl, supersededAt: prev.supersededAt });
  }

  // spec §7c-2: 挿入と同一ミューテーション内 prune(上限超過状態の ledger を返さない)
  return { ...result, ledger: applyPruneSweep(result.ledger, opts.now, opts.caps ?? {}) };
}

// --- CAS ヘルパ: leaseToken 不一致(旧世代の stale イベント)は ledger を変えずに返す ---
function withCas(
  l: Ledger, idemKey: string, leaseToken: string,
  f: (rec: JobRecord) => JobRecord,
): Ledger {
  const rec = l.jobs[idemKey];
  if (!rec || rec.leaseToken !== leaseToken) return l; // stale イベント無視(spec §7c-2 CAS)
  return { ...l, jobs: { ...l.jobs, [idemKey]: f(rec) } };
}

export function applyDownloadStarted(l: Ledger, idemKey: string, leaseToken: string, downloadId: number): Ledger {
  return withCas(l, idemKey, leaseToken, (r) => ({ ...r, state: "requested", downloadId }));
}

export function applyDownloadRequestFailed(l: Ledger, idemKey: string, leaseToken: string, error: string, now?: number): Ledger {
  const next = withCas(l, idemKey, leaseToken, (r) => ({ ...r, state: "error", error, terminalAt: now ?? r.leasedAt, leaseToken: undefined }));
  if (next === l) return l;
  // spec §7c-2: terminal レコードを作る遷移も同一ミューテーション内で prune
  return applyPruneSweep(next, now ?? 0, {});
}

export function applyDownloadComplete(
  l: Ledger, idemKey: string, leaseToken: string, actualFilename: string, doneAt: number,
  caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  const next = withCas(l, idemKey, leaseToken, (r) => ({
    ...r,
    state: "done", doneAt, terminalAt: doneAt, actualFilename,
    pathDivergent: pathMatchesBoundary(actualFilename, r.relPath) ? undefined : true,
    lastDownloadedPostUpdatedAt: r.pendingPostUpdatedAt ?? r.lastDownloadedPostUpdatedAt,
    leaseToken: undefined, leasedAt: undefined, retriedNetwork: undefined,
  }));
  if (next === l) return l; // CAS 不成立(stale)なら prune もしない
  // spec §7c-2: terminal レコードの挿入と同一ミューテーション内 prune
  return applyPruneSweep(next, doneAt, caps);
}

export function applyDownloadInterrupted(
  l: Ledger, idemKey: string, leaseToken: string,
  action: FailureAction, error: string,
  newLeaseToken: () => string, now: number,
  caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  const next = withCas(l, idemKey, leaseToken, (r) => {
    if (action === "retry_once" && !r.retriedNetwork) {
      // 有界リトライ 1 回(spec §6): 新 lease で pending に戻す
      return { ...r, state: "pending", retriedNetwork: true, leaseToken: newLeaseToken(), leasedAt: now, downloadId: undefined, error };
    }
    if (action === "needs_page") {
      return { ...r, state: "needs_page", error, terminalAt: now, leaseToken: undefined, leasedAt: undefined };
    }
    // SERVER_FORBIDDEN(有料 403)は spec §6 の明示文言でレコードに残す(raw code は併記)。
    // refusedUrl も刻み、同一 URL の自動再投入(applyEnqueue の error 再投入分岐)を禁止する。
    if (error === "SERVER_FORBIDDEN") {
      return {
        ...r, state: "error", terminalAt: now, refusedUrl: r.url,
        error: "サーバがダウンロードを拒否しました(未加入の有料コンテンツの可能性)(SERVER_FORBIDDEN)",
        leaseToken: undefined, leasedAt: undefined,
      };
    }
    return { ...r, state: "error", error, terminalAt: now, leaseToken: undefined, leasedAt: undefined };
  });
  if (next === l) return l;
  // spec §7c-2: terminal レコードを作る遷移も同一ミューテーション内で prune
  const rec = next.jobs[idemKey];
  return rec && (rec.state === "error" || rec.state === "needs_page") ? applyPruneSweep(next, now, caps) : next;
}

export function applyNeedsPageRecovery(
  l: Ledger, postId: string,
  fresh: Array<{ stableContentId: string; url: string; basePath: string }>,
  opts: { now: number; postUpdatedAt: string; newLeaseToken: () => string; validatePath: (p: string) => string | null; invalidIds?: Set<string> },
): { ledger: Ledger; toStart: JobRecord[]; missing: string[]; refused: string[]; invalid: string[]; errors: string[] } {
  const jobs = { ...l.jobs };
  const toStart: JobRecord[] = [];
  const missing: string[] = [];
  const refused: string[] = [];
  const invalid: string[] = [];
  const errors: string[] = [];
  const byId = new Map(fresh.map((f) => [f.stableContentId, f]));
  for (const rec of Object.values(l.jobs)) {
    if (rec.postId !== postId || rec.state !== "needs_page") continue;
    if (opts.invalidIds?.has(rec.stableContentId)) {
      // spec §4a: allowlist 違反は「編集で消えた」と区別して明示 error にする
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, error: "メディア URL が許可外のためダウンロードできません" };
      invalid.push(rec.idemKey);
      continue;
    }
    const f = byId.get(rec.stableContentId); // 安定 ID 一致のみ(ordinal 誤バインド禁止 spec §6)
    if (!f) {
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, error: "投稿が編集され該当ファイルは存在しない" };
      missing.push(rec.idemKey);
      continue;
    }
    if (f.url === rec.url) {
      // URL が変わっていない = 編集由来の失効ではない。再投入しても同じサーバ失敗を
      // 繰り返すだけなので中立の明示 terminal error にする(spec §6)。
      // refusedUrl を刻み、後続 applyEnqueue の error 再投入分岐がこの URL を
      // 自動再投入することも禁止する(拒否が同クリックで巻き戻る矛盾の防止)。
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, refusedUrl: rec.url, error: "同じ URL のままサーバ側の失敗が続いています。時間を置いて再試行してください" };
      refused.push(rec.idemKey);
      continue;
    }
    // 世代交代の canonical パス規則は回復経路にも適用(spec §7c-2「世代交代全般」)
    const { generation: gen, relPath } = nextGenerationPath(f.basePath, rec.generation, rec.relPath);
    const err = opts.validatePath(relPath);
    if (err) {
      // パス検証エラーは「編集で消えた」とは別種の失敗として errors に整形済み文言で積む
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: opts.now, error: `${relPath}: ${err}` };
      errors.push(`${rec.idemKey}: パス検証エラー ${relPath}: ${err}`);
      continue;
    }
    const next: JobRecord = {
      ...rec, state: "pending", url: f.url, relPath, generation: gen,
      leaseToken: opts.newLeaseToken(), leasedAt: opts.now, downloadId: undefined,
      pendingPostUpdatedAt: opts.postUpdatedAt,
      supersededUrl: rec.url, supersededAt: opts.now, error: undefined, retriedNetwork: undefined,
      terminalAt: undefined, refusedUrl: undefined,
    };
    jobs[rec.idemKey] = next;
    toStart.push(next);
  }
  // spec §7c-2: 回復も terminal(error)レコードを作り得るため同一ミューテーション内で prune
  const pruned = applyPruneSweep({ ...l, jobs }, opts.now, {});
  return { ledger: pruned, toStart, missing, refused, invalid, errors };
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["done", "error", "needs_page"]);

function tombstoneInto(generations: Record<string, number>, rec: JobRecord): void {
  if (rec.generation > 0) {
    generations[rec.idemKey] = Math.max(generations[rec.idemKey] ?? 0, rec.generation);
  }
}

function capTombstones(generations: Record<string, number>, max: number): Record<string, number> {
  const keys = Object.keys(generations);
  if (keys.length <= max) return generations;
  // 挿入順の古い方から削除(Object のキー順 = 挿入順)。喪失時の最悪ケースは
  // divergent 回復チェーンで収束する(spec §7c-2)。
  const out: Record<string, number> = {};
  for (const k of keys.slice(keys.length - max)) out[k] = generations[k];
  return out;
}

export function applyClearTerminal(l: Ledger): Ledger {
  const jobs: Record<string, JobRecord> = {};
  const generations = { ...l.generations };
  for (const rec of Object.values(l.jobs)) {
    if (TERMINAL_STATES.has(rec.state)) tombstoneInto(generations, rec);
    else jobs[rec.idemKey] = rec; // 進行中は terminal になるまで残す(spec §7c-3)
  }
  return { jobs, generations: capTombstones(generations, 10_000) };
}

export function applyPruneSweep(
  l: Ledger, now: number,
  caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  const maxTerminal = caps.maxTerminal ?? 5_000;
  const maxAgeMs = caps.maxAgeMs ?? 365 * 24 * 3600 * 1000;
  const maxTombstones = caps.maxTombstones ?? 10_000;
  const jobs = { ...l.jobs };
  const generations = { ...l.generations };
  const drop = (rec: JobRecord) => { tombstoneInto(generations, rec); delete jobs[rec.idemKey]; };

  const terminalTime = (r: JobRecord) => r.terminalAt ?? r.doneAt ?? r.leasedAt ?? 0;
  for (const rec of Object.values(l.jobs)) {
    // spec §7c-2: sweep は done に限らず全 terminal(古い error/needs_page も掃除できる)
    if (TERMINAL_STATES.has(rec.state) && now - terminalTime(rec) > maxAgeMs) drop(rec);
  }
  const terminals = Object.values(jobs)
    .filter((r) => TERMINAL_STATES.has(r.state))
    .sort((a, b) => terminalTime(a) - terminalTime(b));
  for (let i = 0; i < terminals.length - maxTerminal; i++) drop(terminals[i]);

  return { jobs, generations: capTombstones(generations, maxTombstones) };
}

export function findLeasesWithoutDownloadId(l: Ledger): JobRecord[] {
  return Object.values(l.jobs).filter((r) => r.state === "pending" && r.leaseToken !== undefined && r.downloadId === undefined);
}

// spec §4a: allowlist 違反 ID の既存ジョブを error 化する(needs_page 回復以外の経路)
export function applyInvalidateByIds(
  l: Ledger, postId: string, invalidIds: Set<string>, now: number,
): { ledger: Ledger; invalidated: string[] } {
  if (invalidIds.size === 0) return { ledger: l, invalidated: [] };
  const jobs = { ...l.jobs };
  const invalidated: string[] = [];
  for (const rec of Object.values(l.jobs)) {
    if (rec.postId !== postId || !invalidIds.has(rec.stableContentId)) continue;
    if (rec.state === "pending" || rec.state === "requested" || rec.state === "needs_page") {
      jobs[rec.idemKey] = { ...rec, state: "error", terminalAt: now, leaseToken: undefined, leasedAt: undefined, error: "メディア URL が許可外のためダウンロードできません" };
      invalidated.push(rec.idemKey);
    }
  }
  return { ledger: applyPruneSweep({ ...l, jobs }, now, {}), invalidated };
}

// spec §7c-2: requeue のたびに leaseToken を再発行する(旧 lease の遅延解決が
// 新試行を汚染しないための CAS 前提)。reconcile の再投入はここを必ず通す。
export function applyReissueLease(
  l: Ledger, idemKey: string, oldToken: string, newToken: string, now: number,
): { ledger: Ledger; record: JobRecord | null } {
  const rec = l.jobs[idemKey];
  if (!rec || rec.leaseToken !== oldToken) return { ledger: l, record: null };
  const next: JobRecord = { ...rec, state: "pending", leaseToken: newToken, leasedAt: now, downloadId: undefined };
  return { ledger: { ...l, jobs: { ...l.jobs, [idemKey]: next } }, record: next };
}
