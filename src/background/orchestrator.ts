import { validatePostInfo } from "../fanbox/api";
import { parsePost, emptyPostNotice } from "../fanbox/parse";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { validateMediaUrl } from "../core/url-allowlist";
import { CONFLICT_ACTION } from "../core/settings";
import { buildRenderContext } from "./render-adapter";
import { zipEligible, collectZipSources, buildZip, downloadZipViaOffscreen, ZIP_FALLBACK_WORDING, ZIP_RETRY_WORDING } from "./zip";
import type { DownloadRequestMessage, DownloadResponse } from "../content/messages";
import type { Settings } from "../core/types";

// spec §変更 A: post.info fetch は content script。SW は受領 json を検証して
// fire-and-forget で DL する。dedup/履歴/resume は持たない。
// リダイレクト検出だけ downloadId→postId の揮発 Map + onChanged で軽量維持(fail-closed)。
const REDIRECT_MAP_KEY = "redirectMap";

// 最終レビュー修正 P2(round2): options.ts の保存ガード(illegalReplacementError)は
// 新規保存だけを防ぐため、旧同期設定に '/' '\' や空文字がそのまま残っている
// ケースは実行時にここで中和する。renderTemplate に渡す前の最後の砦。
export function safeReplacement(rep: string): string {
  if (rep === "" || rep.includes("/") || rep.includes("\\")) return "_";
  return rep;
}

export interface OrchestratorDeps {
  downloads: {
    download(opts: chrome.downloads.DownloadOptions): Promise<number>;
    search(q: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
    erase(q: chrome.downloads.DownloadQuery): Promise<number[]>;
    removeFile(id: number): Promise<void>;
    cancel(id: number): Promise<void>;
  };
  loadSettings: () => Promise<Settings>;
  zip: {
    eligible: typeof zipEligible;
    collect: typeof collectZipSources;
    build: typeof buildZip;
    downloadViaOffscreen: typeof downloadZipViaOffscreen;
  };
  now: () => number;
  session: {
    get(key: string): Promise<any>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  log: (msg: string) => void;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  // downloadId -> postId(リダイレクト再検証用の揮発データ。dedup には使わない)
  const redirect = new Map<number, string>();

  // 並行呼び出しでも session.set が last-write-wins で古いスナップショットに
  // よって新しいエントリを消してしまわないよう、書き込みを単一チェーンで直列化する。
  // スナップショット(Object.fromEntries(redirect))はチェーン内のタスクが実際に実行
  // される時点で評価する(呼び出し時点ではない)ため、直前までの全書き込みが完了した
  // 後の最新状態を、かつ最後に実行される set が確実に書き込む。
  let writeChain: Promise<unknown> = Promise.resolve();
  function persistRedirect(): Promise<void> {
    const next = () => deps.session.set({ [REDIRECT_MAP_KEY]: Object.fromEntries(redirect) });
    writeChain = writeChain.then(next, next);
    return writeChain as Promise<void>;
  }

  // 最終レビュー修正 P1b: SW 起動レース対策。loadRedirectMap() は複数回・複数
  // 経路(service-worker.ts の起動ブロックと handleDownloadChanged からの
  // ensureLoaded)から呼ばれ得るが、実際のロードは 1 回だけにする(冪等)。
  // codex-review 指摘(2/3 巡目): session.get() が一時的に失敗した場合、
  // (a) readyPromise を rejected のまま恒久キャッシュしない(次回呼び出しで
  //     再試行できるよう null に戻す)。
  // (b) それでも「読み込み失敗 = 検証スキップ」は persist 済み(in-memory に
  //     無い)downloadId の fail-closed を取りこぼし得るため、諦める前に
  //     短い遅延を挟んで数回リトライし、純粋な一過性の失敗はここで吸収する
  //     (恒久的な storage 障害まではカバーできないが、その場合 SW 自体が
  //     機能不全であり許容する)。
  const SESSION_GET_RETRY_DELAYS_MS = [20, 60];
  async function loadRedirectMapOnce(): Promise<void> {
    const r = await deps.session.get(REDIRECT_MAP_KEY);
    const obj = (r?.[REDIRECT_MAP_KEY] as Record<string, string>) ?? {};
    for (const [id, postId] of Object.entries(obj)) redirect.set(Number(id), postId);
  }
  async function loadRedirectMapWithRetry(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await loadRedirectMapOnce(); return; }
      catch (e) {
        if (attempt >= SESSION_GET_RETRY_DELAYS_MS.length) throw e;
        await new Promise((r) => setTimeout(r, SESSION_GET_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  let readyPromise: Promise<void> | null = null;
  function loadRedirectMap(): Promise<void> {
    if (!readyPromise) {
      readyPromise = loadRedirectMapWithRetry().catch((e) => { readyPromise = null; throw e; });
    }
    return readyPromise;
  }
  function ensureLoaded(): Promise<void> {
    return loadRedirectMap();
  }

  const mkValidatePath = (s: Settings) => (relPath: string): string | null => {
    const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
    return v.ok ? null : v.error;
  };

  async function startDownload(url: string, filename: string, postId: string): Promise<void> {
    // spec §4a: download 直前に allowlist 再検証(最後の砦)。
    const v = validateMediaUrl(url, postId);
    if (!v.ok) throw new Error(`allowlist 違反: ${v.error}`);
    const id = await deps.downloads.download({ url, filename, saveAs: false, conflictAction: CONFLICT_ACTION });
    redirect.set(id, postId);
    // 最終レビュー3巡目 P2: persist(session.set)が失敗すると、DL 自体は継続するが
    // downloadId→postId の対応が in-memory にしか無くなる。SW 再起動でこの対応が
    // 失われると、complete 時の finalUrl fail-closed 検証が永久にスキップされ、
    // 追跡不能な DL がディスクに残る。それを避けるため、persist に失敗したら
    // download 自体を cancel + removeFile + erase して fail-closed(この DL を
    // 無かったことにする)。cancel は「まだ進行中」を、removeFile は「cancel が
    // 間に合わないほど高速に complete していた」を、それぞれカバーする
    // (chrome.downloads.cancel() の Promise は cancelled/completed/interrupted
    // のいずれかに状態が確定してから resolve するため、両者は排他的に効く。
    // 拡張機能からの cancel が生む中断理由 USER_CANCELED は resume 前提の
    // 一時的ネットワーク障害とは異なり、再開可能な部分ファイルを残さない)。
    //
    // codex-review 指摘(3巡目・4巡目): この persistRedirect() が reject する
    // より前に、同じ downloadId の complete イベントが先に届いて
    // handleDownloadChanged が finalUrl 検証を(開始 or 完了)済みというレースが
    // あり得る。handleDownloadChanged は「この downloadId の結末を引き受ける」と
    // 決めた瞬間(検証を始める前、await を挟まず同期的に)redirect map から
    // 削除するため、ここで `redirect.has(id)` が false なら、それは
    // 「検証が完了済みか進行中かによらず、既に handleDownloadChanged が結末を
    // 引き受けた」ことを意味する(JS の同期実行区間は中断されないため、検証の
    // 開始と削除の間に割り込むことはできない)。その場合は後追いで
    // cancel/removeFile/erase を呼んで正当な DL を壊してはいけない(persist
    // 失敗自体は呼び出し側の errors には載せる)。
    try {
      await persistRedirect();
    } catch (e) {
      if (redirect.has(id)) {
        redirect.delete(id);
        try { await deps.downloads.cancel(id); } catch { /* best-effort */ }
        try { await deps.downloads.removeFile(id); } catch { /* best-effort */ }
        try { await deps.downloads.erase({ id }); } catch { /* best-effort */ }
      }
      throw new Error(`redirect map の永続化に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDownloadRequest(msg: DownloadRequestMessage): Promise<DownloadResponse> {
    const res: DownloadResponse = { queued: 0, zipQueued: 0, notices: [], errors: [] };

    const schemaErr = validatePostInfo(msg.json, msg.postId);
    if (schemaErr) { res.errors.push(schemaErr); return res; }
    const post = parsePost(msg.json);
    if (post.restricted) { res.notices.push("アクセス権がないためダウンロードできません(未加入プランの投稿、または本文を取得できない投稿)"); return res; }
    if (post.skippedEmbeds > 0) res.notices.push(`埋め込みコンテンツ ${post.skippedEmbeds} 件は DL 対象外です`);
    if (post.contents.length === 0) {
      if (post.skippedEmbeds === 0) res.notices.push(emptyPostNotice(post.postType));
      return res;
    }

    const s = await deps.loadSettings();
    // 最終レビュー修正 P2(round2): 旧同期設定の illegalCharReplacement が
    // '/' '\' や空文字のままだと renderTemplate でパス区切りが新生し得るため、
    // 使用前に安全な既定値へ中和する(zip.eligible/build にもこの s を渡すため
    // ここで一度中和すれば個別 DL・zip 両方に効く)。
    s.illegalCharReplacement = safeReplacement(s.illegalCharReplacement);
    const now = new Date(deps.now());
    const vp = mkValidatePath(s);

    // allowlist(spec §4a: あらゆるネットワーク使用の前)
    for (const b of post.contents) {
      b.files = b.files.filter((f) => {
        const v = validateMediaUrl(f.url, post.postId);
        if (!v.ok) res.errors.push(v.error);
        return v.ok;
      });
    }

    for (const b of post.contents) {
      let zipDone = false;
      if (deps.zip.eligible(b, s)) {
        const collected = await deps.zip.collect(b.files.map((f) => ({ url: f.url, size: f.size })), post.postId, {});
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
      if (zipDone) continue;
      for (const f of b.files) {
        if (!(s.contentTypes as any)[f.contentType]) continue;
        let relPath: string;
        try {
          relPath = renderTemplate(s.pathTemplate, buildRenderContext(post, b, f, now), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
        } catch (e) {
          res.errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
          return res; // テンプレ不正は全体中断
        }
        const pv = vp(relPath);
        if (pv) { res.errors.push(`${relPath}: ${pv}`); continue; }
        try { await startDownload(f.url, relPath, post.postId); res.queued++; }
        catch (e) { res.errors.push(String(e)); }
      }
    }
    return res;
  }

  async function handleDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    // 最終レビュー修正 P1b: SW 起動直後、loadRedirectMap() 完了前に onChanged が
    // 発火すると redirect map が空で finalUrl 検証が永久にスキップされ得る。
    // ここで必ずロード完了を待ってから map を参照する(冪等)。
    // codex-review 指摘(2 巡目): ここで失敗を無条件に伝播すると、当セッション中に
    // 既に in-memory 登録済みの downloadId(startDownload が同期的に redirect.set
    // 済み)まで巻き添えで検証をスキップしてしまう(一発勝負の complete イベントを
    // 逃す)。読み込み失敗は無視して in-memory map で処理を続行する
    // (readyPromise は失敗時に null へ戻すので次回呼び出しで再試行される)。
    try { await ensureLoaded(); } catch { /* 一時的な session 読み込み失敗: in-memory map で継続 */ }
    if (!delta.state || delta.id === undefined) return;
    const cur = delta.state.current;
    if (cur !== "complete" && cur !== "interrupted") return;
    const postId = redirect.get(delta.id);
    if (postId === undefined) return; // 自分の通常 DL ではない(zip は SW 側で先に処理)

    if (cur === "interrupted") {
      // 最終レビュー6巡目 P1: interrupted では redirect map の entry を削除
      // しない(何もしない)。Chrome は同一 downloadId のまま resume する
      // ことがある(NETWORK_* 等の一時的失敗からの自動/手動再開)ため、ここで
      // entry を消してしまうと、resume 後に届く complete イベントで
      // `redirect.get` が undefined になり、finalUrl allowlist 再検証
      // (fail-closed)が丸ごとスキップされてしまう。entry を保持しておけば
      // 後続の complete で必ず検証が効く。
      //
      // 二度と resume されなかった場合、この entry は永久に redirect map(と
      // それを持続化する storage.session)に残り続けるが、(a) id→postId の
      // 極小データに過ぎず、(b) storage.session はブラウザ終了で自動的に
      // クリアされ、(c) 何より finalUrl のセキュリティ検証を取りこぼさない
      // ことを優先する、という理由でこれを受容する。
      return;
    }

    // codex-review 指摘(4巡目): startDownload 側にも「persistRedirect() が
    // reject したら fail-closed で cancel/removeFile/erase する」経路があり、
    // これと当関数の finalUrl 検証がほぼ同時に同じ downloadId を触るレースが
    // あり得る。検証完了「後」に削除すると、startDownload 側の経路が検証
    // 進行中(まだ削除前)の downloadId を横から掴んで壊してしまう窓が生まれる
    // ため、この関数がこの downloadId の結末を引き受けると決めた瞬間
    // ―― つまり検証を始める前、await を挟まず同期的に ―― redirect map から
    // 削除し、以後の結末(保持するか破棄するか)はこの関数だけが決める、と
    // 宣言する。JS はこの同期区間を中断できないため、startDownload 側が
    // `redirect.has(id)` を見て「既にこちらが引き受けた」ことを見逃すことは
    // ない(逆に startDownload 側が先に削除していれば、この関数は postId が
    // 引けず早期 return するので二重処理にもならない)。
    redirect.delete(delta.id);

    // 最終レビュー3巡目 P1: spec §変更 A / §4a-3 の finalUrl allowlist 再検証
    // (fail-closed)は、persist より必ず先に完了させる。旧実装は
    // 「削除 → persist → 検証」の順だったため、persist(session.set)が throw
    // すると検証(removeFile 等)に到達しないまま関数が終了してしまっていた。
    //
    // 最終レビュー5巡目 P2b: 検証ブロック自体(search → finalUrl 取得 →
    // allowlist 照合)を try/catch で包む。downloads.search() が reject する
    // (ブラウザ内部エラー等)と、上記と同じ理由で検証に到達できず、リダイレクト
    // 済みの実ファイルがディスクに残ってしまう。「allowlist 外」「item/finalUrl
    // 取得不能」と同様、「検証中に例外」も fail-closed(破棄)に倒す。
    try {
      const [item] = await deps.downloads.search({ id: delta.id });
      // fail-closed(spec §変更 A): finalUrl が無いとき url(要求 URL)で代用しない。
      const finalUrl = (item as any)?.finalUrl as string | undefined;
      if (!item || !finalUrl || !validateMediaUrl(finalUrl, postId).ok) {
        try { await deps.downloads.removeFile(delta.id); } catch {}
        try { await deps.downloads.erase({ id: delta.id }); } catch {}
        deps.log(`[fanbox-dl] 許可外 URL へリダイレクトされた可能性があるためダウンロードを破棄しました(postId ${postId})`); // spec §変更 A: click 応答返却後のため console が通知チャネル(zip と同じ制約)
      }
    } catch (e) {
      try { await deps.downloads.removeFile(delta.id); } catch {}
      try { await deps.downloads.erase({ id: delta.id }); } catch {}
      deps.log(`[fanbox-dl] finalUrl 検証中にエラーが発生したためダウンロードを破棄しました(postId ${postId}): ${e instanceof Error ? e.message : String(e)}`);
    }

    // 検証完了後に persist。ここで persist が失敗しても、fail-closed 検証は
    // 既に完了済みなので致命的ではない(best-effort)。
    try { await persistRedirect(); } catch { /* 追跡データの持続化失敗は致命的ではない(検証は既に完了済み) */ }
  }

  return { handleDownloadRequest, handleDownloadChanged, loadRedirectMap };
}
