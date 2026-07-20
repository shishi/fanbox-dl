# fanbox-dl 変更設計書: 履歴機構の撤去とボタン配置

- 日付: 2026-07-20
- ステータス: 承認済み(shishi、同日・セクション A/B とも)
- 位置づけ: `2026-07-19-fanbox-dl-design.md`(以下「原設計」)を **amend** する変更 spec。
  MVP の E2E 手動ゲートで §13-1(通常 DL)/ §13-4(SPA ボタン)/ §13-5(zip)を確認後、
  shishi の要望で 2 点を変更する。

## 背景

MVP は全 16 タスク実装済み・194 tests green・実 Chrome で通常 DL / SPA / zip の動作確認済み。
その上で shishi が次を要望:
1. dedup(履歴による重複スキップ)と DL 履歴機構を **機能ごと全撤去**。
2. DL ボタンを **投稿ページはタイトル近く**(fantia-dl 同様)、**クリエイター投稿一覧は各投稿カード**にも配置。

## 変更 A: 履歴機構の全撤去(fire-and-forget 化)

原設計 §6(識別子)/ §7c(継承 durability モデル)/ §8(dedup)を支えていた機構の大半を撤去する。
dedup をやめると「二度 DL しない/中断を追跡する」ための仕組みが全て存在理由を失うため。

### 削除するファイル・機構
- モジュール(テスト含む): `src/background/ledger.ts`, `job-store.ts`, `mutation-queue.ts`,
  `adoption.ts`, `settle.ts`, `failure-classifier.ts`, `core/canonical-relpath.ts`
- 永続化: `chrome.storage.local` の job ledger、options の「DL 履歴クリア」ボタン、
  1 年 sweep・terminal 件数上限・tombstone(`generations`)
- 状態機械: lease / leaseToken / CAS、generation・`.rev{N}` 命名・supersededUrl/At、
  needs_page 回復、pending/requested/done/error の永続 state
- 鮮度: updatedDatetime 警告(pendingPostUpdatedAt / lastDownloadedPostUpdatedAt /
  lastWarnedPostUpdatedAt)
- UI: **🔄(再ダウンロード)ボタンを削除**(毎回の ⬇ がそのまま再 DL になり意味が消えるため)
- **DL 前の URL allowlist 検証(host+path 形状+postId 一致)は維持**。
- **finalUrl リダイレクト再検証(原設計 §4a-3)は軽量な形で維持する**(dedup とは別の
  独立セキュリティ制御。DL 前 allowlist は初期 URL しか見ず chrome.downloads はリダイレクトを
  追うため、これが唯一のリダイレクト検出経路)。ledger は復活させず、**`downloadId → postId` の
  小さな Map(SW メモリ + `chrome.storage.session` に同期し SW 再起動耐性を持たせる)** と
  下記の通常 DL 用 onChanged だけで実現する。詳細は撤去後フロー 5 を参照。

### 撤去後のダウンロードフロー(normative)
1. content script が isolated world で `post.info` を fetch(原設計 §4a canonical・**変更なし**)し、
   json を `chrome.runtime.sendMessage({kind:"download", postId, force?, json})` で SW へ渡す
   (`force` フィールドは廃止してよい。以降は常に「今の内容をそのまま DL」)。
2. SW: `validatePostInfo`(schema)→ `parsePost` → 各 FileItem について
   render-adapter でパス生成(template-engine + sanitizer + path-validator、いずれも無改造 core)→
   `validateMediaUrl(url, postId)`(allowlist・維持)→ 検証を通ったものだけ
   `chrome.downloads.download({url, filename, saveAs:false, conflictAction:"uniquify"})` を
   **投げっぱなし(結果を永続追跡しない)**。
3. 同名衝突は Chrome の `uniquify`(`foo (1).ext`)に委ねる。DL 済み判定・resume・
   再投入は行わない。
4. **zip 経路は維持**(原設計 §7b。元々 one-shot で履歴外)。zip 不成立時の個別 DL
   フォールバック(§7b)も維持。
5. **通常 DL の onChanged は「finalUrl リダイレクト検出」のためだけに軽量に残す**
   (完了/中断の永続追跡・resume・needs_page は行わない)。`download()` 成功時に
   `downloadId → postId` を Map に記録(storage.session 同期)。`onChanged` の complete で
   その downloadId が Map にあれば `DownloadItem.finalUrl` を `validateMediaUrl(finalUrl, postId)`
   で照合し、**allowlist 外なら `chrome.downloads.removeFile` + `erase` して破棄**する。
   **通知チャネル(normative)**: この onChanged は click 応答を返した後に発火するため
   content script の alert へは届かない(原設計 §7b の zip 失敗と同じ配達制約)。よって
   破棄の通知は **SW の console(`console.error`)へのログ**とする(「許可外 URL へ
   リダイレクトされた可能性があるためダウンロードを破棄しました」)。ファイル自体は
   removeFile+erase で除去済みのため、脅威は通知の有無によらず中和される。
   **fail-closed(normative)**: complete 時に `chrome.downloads.search({id})` で完全な
   `DownloadItem` を取得し、item が得られない/`finalUrl` を確定できない場合は「検証済み」と
   みなさず、上記と同じ破棄+ログに倒す(**`finalUrl` が無いとき `url`(要求 URL)で代用しない**
   ── 要求 URL は allowlist 通過済みでリダイレクト先を反映しないため。finalUrl が唯一の
   リダイレクト検出経路になったため、
   未確認を成功扱いしない)。照合後(成功・失敗・未確認どれでも)Map から除去。zip の blob URL
   revoke 用の onChanged 分岐も併存する(既存)。この Map は dedup には一切使わない
   (照合が済めば消える揮発データ)。
   テスト: (a) finalUrl が allowlist 外 → 破棄+通知、(b) **item/finalUrl が取得不能 → fail-closed で
   破棄+通知**、(c) 正常 finalUrl → 何もしない、の 3 ケースを orchestrator テストで固定。

### 識別子の扱い
`stableContentId` / `blockOrdinal` の分離(原設計 §6)は render のためではなく主に dedup 用だった。
撤去後は idemKey も不要。`blockOrdinal`(= `$contentId` の値)は**テンプレ用に残す**。
parse は各ファイルのメタ(url / filename / ext / seq / total / contentType / blockOrdinal)を返せば十分で、
`stableContentId` / `idemKey` / `refetch` フィールドは撤去する。

### 残る型・設定
- `Settings` から履歴関連は元々無い(dedup は ledger 側だった)。`conflictAction` は既に
  uniquify 固定(原設計 §8)なので不変。options から履歴クリア UI を削除。
- 通知(restricted / embed 対象外 / zip フォールバック / allowlist 違反)は dedup 非依存なので**維持**。

## 変更 B: DL ボタンの配置

fanbox は pixiv の SPA でクラス名がハッシュ化されるため、**ハッシュクラスに依存しない
構造 / href ヒューリスティック + フォールバック**で注入する。

### ① 投稿ページ: タイトル近く(fantia-dl 方式)
- 投稿タイトル見出しの隣にボタンを挿入する。検出は耐性ヒューリスティック:
  main / article 相当の領域内の最初の `h1`(無ければ最大の見出し要素)を探し、その隣に挿入。
- SPA の遅延描画に備え `MutationObserver` でタイトル出現を待つ(タイムアウトあり)。
- **見つからなければ従来の固定右下配置にフォールバック**(ボタンが必ず出る保証)。
- ボタンは ⬇ のみ(🔄 削除)。クリックで post.info fetch → SW で DL(変更 A のフロー)。

### ② クリエイター投稿一覧: 各カードにボタン
- **`href` で投稿カードを検出**(ハッシュ CSS クラス非依存): `/posts/{id}` または
  `/@{creator}/posts/{id}` にマッチするアンカーを走査し、投稿(postId ごとにユニーク化)ごとに
  小さな ⬇ ボタンを 1 個注入する。
- クリックでそのカードの postId の post.info を isolated world で fetch → SW で投稿全体を DL
  (投稿ページのボタンと同一フロー。トリガが変わるだけ)。
- **クリック時は `preventDefault()` + `stopPropagation()` でカードのリンク遷移を必ず抑止する**
  (クリック可能カードに素朴に注入すると「DL しつつ投稿ページへ遷移」してしまうため)。
  ボタンはカードのアンカー hit 領域と重ならない位置(カード角のオーバーレイ等)に置く。
- 無限スクロール・SPA 遷移で増えるカードにも `MutationObserver` で注入。重複注入は
  postId またはボタン要素のデータ属性でガードする。
- **クリエイター投稿一覧の面でのみ有効化**(URL 判定)。ホーム / タグ / フォロー中は対象外。
- **実装時の hard gate(オリジン確認)**: 原設計が 200 を実証したのは `www.fanbox.cc` オリジンの
  投稿ページのみ。クリエイター投稿一覧ページの**実行オリジンで isolated-world の `post.info`
  fetch が 200 になること**を実機で確認してから一覧ボタンを有効化する。一覧ページが
  `{creator}.fanbox.cc` オリジンで動き api が 400 を返す場合は、一覧ボタン機能を**見送り**
  (投稿ページのタイトル近く配置のみ実装)、別途 spec 改訂で www オリジン経由の取得手段を設計する。
  投稿ページ側は www 正規化済み(原設計 §4a)なので影響しない。

### 共通
- content script の matches は `https://*.fanbox.cc/*` 全域常駐のまま(原設計 §12・SPA 対応)。
- クリックのフィードバックは現状維持(`⬇ N 件開始` 等の一時テキスト差し替え)。
- 一覧の各カードからの DL は、content script の isolated world fetch が一覧ページの実行オリジンから
  任意 postId の post.info を 200 で引けること(上記 hard gate)に依存する。

## テスト方針
- 削除対象のテスト群(ledger / job-store / mutation-queue / adoption / settle /
  failure-classifier / canonical-relpath 系)は削除。
- parse は `stableContentId` / `idemKey` / `refetch` を落とした新シェイプに合わせてテスト更新
  (image / file / article / restricted / text / embed カウント の各フィクスチャは維持)。
- render-adapter / url-allowlist / zip / template・sanitizer・path-validator(core)テストは維持。
- orchestrator は fire-and-forget フローに合わせて再構成(zip フォールバック / allowlist 違反で
  download() 不到達 / restricted 通知 の契約テストは維持。dedup / needs_page 系テストは削除。
  **finalUrl リダイレクト検出テストは維持**: complete で finalUrl が allowlist 外なら
  removeFile+erase+通知され、downloadId→postId Map から除去される契約をテストする)。
- content script のボタン検出(href パターンでの postId 抽出・カードのユニーク化・title 検出の
  フォールバック判定)は**純粋関数として切り出して単体テスト**する(DOM 配線自体は手動確認)。

## スコープ外(YAGNI)
- 一覧のホーム / タグ / フォロー面へのボタン展開。
- DL 済みの視覚的マーキング(履歴を撤去するため不可能かつ不要)。
- 有料投稿の cookie 依存フォールバック(原設計 §7a・別 spec のまま)。
