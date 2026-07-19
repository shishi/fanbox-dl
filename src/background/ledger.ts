import { canonicalRelPath } from "../core/canonical-relpath";

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

const TERMINAL: ReadonlySet<JobState> = new Set(["done", "error", "needs_page"]);

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
    supersededUrl: prev?.url, supersededAt: prev ? opts.now : undefined,
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

    if (!TERMINAL.has(prev.state)) {
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

// Task 9 時点の一時 stub(pass-through)。Task 10 が本実装(件数上限・sweep・tombstone)に
// 置き換える。function 宣言なので applyEnqueue から前方参照できる。
export function applyPruneSweep(
  l: Ledger, _now: number,
  _caps: { maxTerminal?: number; maxAgeMs?: number; maxTombstones?: number } = {},
): Ledger {
  return l;
}
