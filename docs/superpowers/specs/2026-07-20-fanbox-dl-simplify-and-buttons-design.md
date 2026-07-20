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
- リダイレクト対策のうち **finalUrl 再検証(原設計 §4a-3)は撤去**(ledger の error マークに
  依存していたため)。**DL 前の URL allowlist 検証(host+path 形状+postId 一致)は維持**。

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
4. **zip 経路は維持**(原設計 §7b。元々 one-shot で履歴外)。`chrome.downloads.onChanged` は
   **zip の blob URL revoke(offscreen リーク防止)のためだけ**に残し、通常 DL の完了/中断を
   追跡する分岐は削除する。zip 不成立時の個別 DL フォールバック(§7b)も維持。

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
- 無限スクロール・SPA 遷移で増えるカードにも `MutationObserver` で注入。重複注入は
  postId またはボタン要素のデータ属性でガードする。
- **クリエイター投稿一覧の面でのみ有効化**(URL 判定)。ホーム / タグ / フォロー中は対象外。

### 共通
- content script の matches は `https://*.fanbox.cc/*` 全域常駐のまま(原設計 §12・SPA 対応)。
- クリックのフィードバックは現状維持(`⬇ N 件開始` 等の一時テキスト差し替え)。
- 一覧の各カードからの DL は、content script の isolated world fetch がどの fanbox.cc ページからでも
  任意 postId の post.info を 200 で引ける(gate §13-6 v2 で実証)ことに依存する。

## テスト方針
- 削除対象のテスト群(ledger / job-store / mutation-queue / adoption / settle /
  failure-classifier / canonical-relpath 系)は削除。
- parse は `stableContentId` / `idemKey` / `refetch` を落とした新シェイプに合わせてテスト更新
  (image / file / article / restricted / text / embed カウント の各フィクスチャは維持)。
- render-adapter / url-allowlist / zip / template・sanitizer・path-validator(core)テストは維持。
- orchestrator は fire-and-forget フローに合わせて再構成(zip フォールバック / allowlist 違反で
  download() 不到達 / restricted 通知 の契約テストは維持。dedup / needs_page / finalUrl 系テストは削除)。
- content script のボタン検出(href パターンでの postId 抽出・カードのユニーク化・title 検出の
  フォールバック判定)は**純粋関数として切り出して単体テスト**する(DOM 配線自体は手動確認)。

## スコープ外(YAGNI)
- 一覧のホーム / タグ / フォロー面へのボタン展開。
- DL 済みの視覚的マーキング(履歴を撤去するため不可能かつ不要)。
- 有料投稿の cookie 依存フォールバック(原設計 §7a・別 spec のまま)。
