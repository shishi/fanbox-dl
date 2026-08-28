import { CONFLICT_ACTION } from "../core/settings";

// downloads.onDeterminingFilename の横取り対策。
//
// chrome.downloads.download({ filename }) の filename は「提案」に過ぎない。
// downloads.onDeterminingFilename リスナーを登録した拡張がブラウザに居ると、
// こちらのテンプレ名が捨てられ、URL / Content-Disposition 由来の生ファイル名で
// 保存される(実測: 2026-08-18 に MarkSnip を入れた後、本拡張の DL が全て
// 生ファイル名になった)。同じイベントに出て名前を言い直す以外に手が無い。
//
// 効き方の前提(誤解すると障害対応で迷うので明記する):
// - 同イベントに複数の拡張が出て、いずれも suggest を返した場合、Chrome は
//   後からインストールされた拡張の suggest を採る。つまりこのリスナーを足せば
//   常に勝てるわけではない。
// - 実測環境では MarkSnip は自分が発行した DL 以外に suggest を返さない実装
//   (shared/download-tracker.js の handleFilenameConflict が false を返す)
//   なので、本拡張が唯一の suggester になり通る。将来「全 DL に suggest する
//   拡張」を本拡張より後にインストールすると再び負ける。そのときの症状は
//   「テンプレが効かない」で、今回の症状と区別が付かない。
//
// また「全ての DL に suggest する」実装は他拡張を同じやり方で壊す加害側に回る。
// 自分が発行したと積極的に同定できた DL にだけ suggest し、それ以外は suggest を
// 呼ばずに false を返す。
export interface DeterminingFilenameSuggestion {
  filename: string;
  conflictAction: typeof CONFLICT_ACTION;
}

type DeterminingFilenameListener = (
  item: { url?: string },
  suggest: (s: DeterminingFilenameSuggestion) => void,
) => void;

export interface DeterminingFilenameEvent {
  addListener(listener: DeterminingFilenameListener): void;
  removeListener(listener: DeterminingFilenameListener): void;
}

export interface FilenameGuard {
  // 永続 listener にすると、claim の無い姉妹拡張も全 DL のファイル名決定へ参加し、
  // Chromium が自動補完する空 suggest() と所有側の suggest が競合警告になる。
  // event 自体は一度 bind し、実 listener は pending claim がある間だけ登録する。
  bindDeterminingFilenameEvent(event: DeterminingFilenameEvent): void;
  // claim → download →(失敗なら claim 取り消し)を閉じ込めた発行口。
  // onDeterminingFilename と download() の解決の前後関係は保証されていない
  // (未実測)ため downloadId では紐付けられない。キーにできるのは URL だけ。
  // 呼び出し側が claim を書き漏らす余地を残さないよう、chrome.downloads.download
  // を直接呼ばずに必ずここを通す(通常 DL と zip の blob DL の両方)。
  claimAndDownload(url: string, filename: string, download: () => Promise<number>): Promise<number>;
  handleDeterminingFilename(
    item: { url?: string },
    suggest: (s: DeterminingFilenameSuggestion) => void,
  ): boolean;
}

export function createFilenameGuard(): FilenameGuard {
  // URL -> その URL で待っているテンプレ名の FIFO。
  // 同じ URL の DL が重なる(同じ投稿を続けてクリックする・2 タブで開く)と、
  // 1 URL = 1 スロットでは後勝ちの上書きになり、片方の determining イベントで
  // claim が引けず、その 1 本だけ生ファイル名で保存されてしまう。キューにして
  // 発行順に消費する。
  const claims = new Map<string, string[]>();
  let determiningFilenameEvent: DeterminingFilenameEvent | undefined;
  let listening = false;

  const listener: DeterminingFilenameListener = (item, suggest) => {
    handleDeterminingFilename(item, suggest);
  };

  function syncListener(): void {
    if (!determiningFilenameEvent) return;
    const shouldListen = claims.size > 0;
    if (shouldListen === listening) return;
    if (shouldListen) determiningFilenameEvent.addListener(listener);
    else determiningFilenameEvent.removeListener(listener);
    listening = shouldListen;
  }

  // claim 時に渡す URL 文字列(API JSON 由来)と、イベントで届く
  // DownloadItem.url は表記がズレ得るため、両側を同じ関数に通して突き合わせる。
  const keyOf = (url: string): string => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };

  function claim(url: string, filename: string): void {
    if (!url) return;
    const key = keyOf(url);
    const queue = claims.get(key);
    if (queue) queue.push(filename);
    else claims.set(key, [filename]);
    syncListener();
  }

  // 自分が積んだ claim 1 件だけを取り消す。
  //
  // 「キューの末尾を落とす」実装にしてはいけない。claim() と download() の間で
  // 制御が移るため、こちらが await している隙に同一 URL の別の DL が claim を
  // 積める。末尾を落とすと、その別の DL の claim を巻き込んで消してしまい、
  // 巻き込まれた側だけが生ファイル名で保存される(= 本モジュールが直している
  // 症状そのものを、より分かりにくい形で再現してしまう)。
  // 値一致で消し、既に determining イベントに消費されていれば何もしない。
  function release(url: string, filename: string): void {
    if (!url) return;
    const key = keyOf(url);
    const queue = claims.get(key);
    if (!queue) return;
    const at = queue.indexOf(filename);
    if (at < 0) return; // 既に消費済み: 他の DL の claim には手を出さない
    queue.splice(at, 1);
    if (queue.length === 0) claims.delete(key);
    syncListener();
  }

  function handleDeterminingFilename(
    item: { url?: string },
    suggest: (s: DeterminingFilenameSuggestion) => void,
  ): boolean {
    const url = item?.url;
    if (!url) return false;
    const key = keyOf(url);
    const queue = claims.get(key);
    if (!queue || queue.length === 0) return false; // 自分の DL ではない: 干渉しない
    const filename = queue.shift() as string;
    if (queue.length === 0) claims.delete(key);
    try {
      suggest({ filename, conflictAction: CONFLICT_ACTION });
    } finally {
      // suggest() を先に送る。listener を先に外すと Chromium が pending determiner の
      // 離脱として処理し、今回の提案を受け取る前にファイル名決定を完了し得る。
      syncListener();
    }
    return true;
  }

  return {
    bindDeterminingFilenameEvent(event) {
      if (determiningFilenameEvent && determiningFilenameEvent !== event) {
        throw new Error("downloads.onDeterminingFilename は一度だけ bind できます");
      }
      determiningFilenameEvent = event;
      syncListener();
    },
    async claimAndDownload(url, filename, download) {
      claim(url, filename);
      try {
        return await download();
      } catch (e) {
        release(url, filename);
        throw e;
      }
    },
    handleDeterminingFilename,
  };
}

// service-worker が生成して orchestrator へ注入し、zip も参照する SW 単一インスタンス。
// storage には持たせない(SW を跨いだ復元はしない)。MV3 の SW は idle で終了し、
// その時点でこの Map ごと消えるため、消費されずに残った claim も SW の生存期間に閉じる。
// zip.ts の zipDownloads や orchestrator の redirect map が storage.session +
// 起動時復元を持つのは、DL 完了時まで生き延びる必要があるからで、要件が異なる。
//
// 既知の残存リスク(承知のうえで対処していない):
// claim は determining イベントで消費されるか、download() の失敗で取り消される。
// どちらも起きない DL があると claim が残り、SW が生きている間に同じ URL を
// 別の主体(ユーザーの右クリック保存・他拡張)が落とすと、その DL に本拡張の
// テンプレ名が付く。orchestrator の fail-closed 経路(persist 失敗で DL を
// 無かったことにする箇所)がこれに当たり得る。そこから取り消しを呼ばないのは、
// 必要かどうかが「download() の解決と determining イベントの前後関係」に依存し、
// それが未実測だから。実害は上記のとおり限定的なので、確かめずに手を入れない。
// 「右クリック保存したファイルに fanbox-dl のテンプレ名が付いた」を見たら、ここが原因。
export const filenameGuard = createFilenameGuard();
