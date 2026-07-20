# 最終レビュー指摘の修正レポート

## 対象

whole-branch 最終レビュー(codex native)が検出した 2 件を TDD で修正した。

## P1: redirect-map 永続化のレース(src/background/orchestrator.ts)

- 問題: `persistRedirect()` が並行呼び出しで session.set を直列化しておらず、
  スナップショットも呼び出し時点で評価していたため、後発の書き込みが先に
  完了すると古いスナップショットで上書きされ、エントリが失われ得た
  (SW 再起動後の finalUrl fail-closed 検証がスキップされる経路)。
- 修正: `writeChain` という単一 promise チェーンで session.set 呼び出しを
  直列化し、`Object.fromEntries(redirect)` の評価をチェーン内タスクの実行時点
  まで遅延させた。これにより最後に実行される set が必ず最新の map を書く。
- テスト: tests/orchestrator.test.ts に「2 件の DL をほぼ同時に開始 → session
  に保存された map に両 downloadId(実際は両 postId)が残る」レーステストを
  追加。session.set の解決順序をわざと入れ替える mock で検証。
- RED 確認: 追加した race テストは、修正前の実装に対して
  `expected [ '1' ] to deeply equal [ '1', '2' ]` で red 落ち。修正後は green。
  さらに `git stash` で src/background/orchestrator.ts を一時的に旧実装へ
  戻し、同テストのみが red になり他 7 件は green のままであることを確認して
  from stash pop で復元(コミット前の作業ツリーは変更なし)。
  加えて、旧実装/新実装の persistRedirect ロジックのみを切り出したスクラッチ
  スクリプトでも、旧実装がエントリを 1 件失い(`["1"]`)、新実装が両方保持する
  (`["1","2"]`)ことを独立に確認した(コミット対象外・破棄済み)。

## P2: isCreatorPostListPage がサブドメイン形式を取りこぼす(src/content/dom-helpers.ts)

- 問題: `isCreatorPostListPage(pathname)` は www の `/@slug(/posts)?` だけ
  true で、`creator.fanbox.cc/` や `creator.fanbox.cc/posts` では一覧ボタンが
  出なかった。
- 修正: シグネチャを `isCreatorPostListPage(pathname: string, host: string)`
  に変更。true になるのは (a) 従来の www 形式、または (b) host が
  `^[^.]+\.fanbox\.cc$` にマッチしかつ `www.fanbox.cc` でないクリエイター
  サブドメインで、pathname が `/` または `/posts` または `/posts/`。投稿詳細
  `/posts/{id}` は host によらず false。
- 呼び出し側 src/content/content-script.ts の 2 箇所
  (`sync()` と MutationObserver コールバック)を
  `isCreatorPostListPage(location.pathname, location.host)` に更新。
- テスト: tests/dom-helpers.test.ts の isCreatorPostListPage テストを host 付き
  に更新し、(a) www `/@slug` true、(b) サブドメイン `creator.fanbox.cc` の
  `/`・`/posts`・`/posts/` true、(c) www のホーム `/` は false、(d) 投稿詳細
  `/posts/{id}` は host 問わず false、を検証する 6 ケースに分割。

## 完了確認

- `bun run test`: 12 files / 120 tests all green(新規 2 テスト含む)。
- `bun run typecheck`: エラーなし。
- `bun run build`: 4 バンドル成功。
- core(src/core/{template-engine,sanitizer,path-validator,base64}.ts)無改造:
  `git diff --stat f67156f..HEAD -- <core files>` は空を確認済み。
- codex native レビュー(この修正差分に対して再実行): "I did not identify an
  actionable bug in the modified lines." で clean(1 回目で通過、反復不要)。
- コミット: `e679b5c` "fix: serialize redirect-map persistence; detect
  creator subdomain list pages (final review)"(5 files changed, 63
  insertions, 17 deletions)。

## 懸念・留保事項

- なし。RED→GREEN のサイクル、旧実装への一時 stash による独立 RED 再現、
  codex native レビューのいずれも想定どおりの結果で、未解決事項はない。

## 最終レビュー修正 第2巡 (2026-07-20)

対象: 最終レビュー第2巡の指摘 3 件(P1a/P1b/P2)。core(template-engine/sanitizer/path-validator/base64)は無改造。

- コミット: 8870dc2 "fix: post-nav button reads current postId, await redirect-map load before onChanged, neutralize persisted illegalCharReplacement (final review round 2)"
- テスト: `bun run test` 全 green(127/127、新規追加 7)
- typecheck: `tsc --noEmit` 0 エラー
- build: `bun scripts/build.mjs` 成功
- core 無変更: `git diff --stat f67156f..HEAD -- src/core/template-engine.ts src/core/sanitizer.ts src/core/path-validator.ts src/core/base64.ts` 空

### 修正内容

- **P1a**(src/content/content-script.ts): `placePostButton()` を引数なしに変更し、投稿ページボタンの click ハンドラはクリック時点で `postIdFromPathname(location.pathname)` を読むよう修正。post→post の SPA 遷移で旧 postId のまま DL される不具合を解消。null の場合は何もしない。カードボタン(injectListButtons)は各カード固有 postId を握ったままで変更なし。DOM テスト基盤(jsdom/happy-dom)が本リポジトリに無く、他の content-script/service-worker 相当の glue コードにも単体テストが存在しない既存方針に合わせ、本修正には自動テストを追加していない(懸念として明記)。

- **P1b**(src/background/orchestrator.ts): `loadRedirectMap()` を冪等化し、`handleDownloadChanged` の先頭で `ensureLoaded()`(内部で `loadRedirectMap()` を起動して待つ)を通すよう修正。SW 起動レースで redirect map 未ロードのまま `onChanged` が発火しても、保存済み downloadId→postId map を読み込んでから finalUrl 検証する。
  - codex-review(native モード)で 3 巡の指摘を受けて反復修正:
    1. 巡目: `session.get()` が一時的に失敗すると `readyPromise` が rejected のまま恒久キャッシュされ、以後 SW の寿命が尽きるまで検証が永久スキップされる → 失敗時に `readyPromise` を null に戻し次回リトライ可能にした。
    2. 巡目: それでも `ensureLoaded()` の失敗を無条件に伝播すると、当セッション中に in-memory 登録済み(startDownload が同期的に redirect.set 済み)の downloadId まで巻き添えで検証をスキップする → `ensureLoaded()` の失敗を catch して in-memory map で処理を継続するよう修正。
    3. 巡目: 「読み込み失敗 = 検証スキップ」のままだと persist 済み(in-memory に無い)downloadId の fail-closed を取りこぼし得る → `loadRedirectMap` 内に短い遅延(20ms/60ms)を挟んだ 2 回のリトライを追加し、純粋な一過性の失敗を吸収するようにした。
  - 4 巡目の codex-review は clean("I did not identify any discrete regressions")。
  - 残存する理論的リスク: 3 回連続(初回+リトライ2回、合計 80ms 超)session.get が失敗し続ける持続的な storage 障害の場合、persist 済み(in-memory に無い)downloadId の fail-closed 検証は取りこぼされる。これは volatile Map + 非同期 persist backup という設計自体が内包するトレードオフであり、「読み込み不能な未知 id は全て危険とみなす」という代替設計は無関係な一般ダウンロードまで誤って削除する重大な regression になるため採用しなかった。

- **P2**(src/background/orchestrator.ts): 純粋関数 `safeReplacement(rep: string): string` を追加(`/` `\` を含む、または空文字なら `_` に置換、それ以外はそのまま)。`handleDownloadRequest` 内で `loadSettings()` 直後に `s.illegalCharReplacement = safeReplacement(s.illegalCharReplacement)` を適用し、以降個別 DL・zip 両方の `renderTemplate` 呼び出しに安全な値が伝播するようにした。options.ts の保存ガード(illegalReplacementError)は新規保存のみ防ぐため、旧同期設定に残る不正値への実行時防御として機能する。

### 追加テスト(tests/orchestrator.test.ts)

1. safeReplacement: `/` → `_`
2. safeReplacement: `\` → `_`
3. safeReplacement: 空文字 → `_`
4. safeReplacement: 正常値はそのまま
5. SW 起動レース: loadRedirectMap 未呼び出しでも session の保存済みマップを読み込んでから finalUrl 検証する(fail-closed)
6. codex-review 指摘(2巡目): redirect-map 再読み込みが持続的に失敗しても in-memory 登録済み DL は検証を続行し、失敗はキャッシュせず障害解消後にリトライする
7. codex-review 指摘(3巡目): session.get が数回連続で一時的に失敗してもリトライで復旧し、persist 済み downloadId の検証を取りこぼさない

計 7 テスト追加(tests/orchestrator.test.ts: 8 → 15、リポジトリ全体: 120 → 127)。

## 最終レビュー第3巡: P1/P2/P3 修正(TDD)

対象コミット: 4db5d77
core 無改造: `git diff --stat f67156f..HEAD -- src/core/{template-engine,sanitizer,path-validator,base64}.ts` は空(確認済み)。

### 修正内容

- **P1(src/background/orchestrator.ts handleDownloadChanged)**: complete 時、
  finalUrl allowlist 検証を redirect map からの削除・persist より必ず先に
  完了させるよう順序を反転。persist(session.set)が失敗しても fail-closed
  検証(removeFile/erase)は既に完了済みになる。interrupted は従来どおり
  検証不要で delete+persist のみ。

- **P2(src/background/orchestrator.ts startDownload)**: persistRedirect が
  失敗したら download を cancel+removeFile+erase して fail-closed にし、
  追跡不能な DL を残さない。OrchestratorDeps.downloads に `cancel(id)` を
  追加し service-worker.ts で `chrome.downloads.cancel` を束縛。

- **P3(src/content/content-script.ts injectListButtons)**: 投稿一覧の 1
  カードに複数の /posts/{id} anchor がある場合のボタン重複を postId 単位で
  dedup。

### codex-review(native, `--uncommitted`)を 6 巡実施、5 件の追加欠陥を fix→re-review で解消

1. **cancel/removeFile 両方必要**: 高速 DL は persist 失敗検知前に complete
   し得るため cancel だけでは足りない。removeFile も呼ぶよう追加。
2. **cancel 後の再開可能パーティションファイル懸念**: chrome.downloads 公式
   リファレンスで cancel()/removeFile()/canResume の仕様を確認し、
   USER_CANCELED は resume 前提のネットワーク中断と異なり再開可能ファイルを
   残さないことを検証・コメントに明記(→ 追加修正不要と判断)。
3. **persist 失敗クリーンアップが「既に検証完了/進行中」の正当な DL を横取り
   して壊すレース**: handleDownloadChanged が「この downloadId の結末を
   引き受ける」と決めた瞬間(検証開始前、await を挟まず同期的)に redirect
   map から削除するよう変更。startDownload 側は `redirect.has(id)` が false
   なら手を出さない。JS の同期実行区間は中断されないためレースが原理的に
   閉じる。テストで実際に修正前は RED になることを確認済み。
4. **dedup マーカーの anchor 依存が DOM 部分再レンダリングで破綻**: 選んだ 1
   anchor だけにマークすると重複再発、全 anchor にマークすると逆にボタン
   消失が永続化。根本原因(マーカーと実体が別ノード)を解消するため、
   「既にボタンがあるか」をボタン自身の生存(data-fbxdl-for)から判定する
   設計に変更(indicesToMarkAsInjected は不要になり削除)。
5. **実 fanbox DOM を検証した上での指摘: 最初の occurrence を選ぶと共有
   コンテナ側の外側 wrapper anchor を選んでしまい、ボタンが個々のカードでは
   なく共有コンテナに積み上がる**: 実際に headless Chrome で
   `https://www.fanbox.cc/@ropy/posts` の DOM を取得し、1 投稿につき外側
   CardPostItem__Wrapper(親 = 共有コンテナ)と内側 PostCover__StyledLink
   (親 = 個々のカード)が入れ子になっていることを確認した上での指摘。
   祖先 anchor は子孫より必ず先に querySelectorAll に現れる不変則を利用し、
   同一 postId 内では「文書順で最後」を選ぶよう変更(常により深くネストされた
   側を選ぶ)。

### 6巡目で codex から出た 2 件は対応せず、懸念として記録

- **[orchestrator.ts] interrupted が persist 失敗より先に届くと fail-closed
  cleanup が完全にスキップされる**: 検証したところ、これは今回の変更が
  作った回帰ではなく、変更前から存在した仕様どおりの挙動(interrupted は
  「検証不要、delete+persist のみ」と元コードから明記されている)。今回の
  P2 修正は「persist 失敗時に他の誰も処理していなければ fail-closed で
  片付ける」安全網であり、interrupted 側が既に(仕様どおり)結末を確定させて
  いる場合にまで手を広げる話ではないため、対応しなかった。
- **[content-script.ts] 同一 postId が正当に複数カード(pin 留め + 通常
  フィード等)で表示される場合、dedup により片方にしかボタンが付かない**:
  ユーザー指示書に明記された「postId 単位で dedup」という設計そのものへの
  疑義であり、fanbox の実ページでこの表示パターンが実在するかは未検証
  (5 件目のような実 DOM 確認は行っていない、codex の推測ベースの指摘)。
  指示された設計を逸脱してまで対応する根拠が無いため、既知のトレードオフ
  として記録するにとどめた。

### 完了確認

- `bun run test`: 137 tests, 12 files, all green
- `bun run typecheck`: エラー 0
- `bun run build`: 成功(content-script.js 7.6kb / service-worker.js 47.9kb
  / options.js 12.0kb / offscreen.js 1.5kb)
- core 4 ファイル差分: 空

## 最終レビュー第4巡: postIdFromHref 外部ホスト検査(TDD)

対象コミット: b2cf1ef
対象ファイル: src/content/dom-helpers.ts / tests/dom-helpers.test.ts
core 無改造: 確認済み

### 修正内容

- **問題**: `postIdFromHref` は絶対 URL を pathname に落とすだけでホスト検査が無く、
  `https://example.com/posts/123` を fanbox 投稿 123 と誤認する。一覧ページの
  外部リンクに DL ボタンが付き誤 DL する。

- **修正**: `postIdFromHref(href)`: 絶対 URL の場合は host が `fanbox.cc` または
  `*.fanbox.cc` のときだけ postId を返す(それ以外は null)。相対 URL(host 無し)は
  従来どおり許可。実装例:
  ```ts
  export function postIdFromHref(href: string): string | null {
    try {
      const u = new URL(href, "https://www.fanbox.cc");
      // 絶対 URL で fanbox 以外のホストは対象外(外部リンク誤認防止)
      if (u.host !== "fanbox.cc" && !u.host.endsWith(".fanbox.cc")) return null;
      return postIdFromPathname(u.pathname);
    } catch {
      return null;
    }
  }
  ```
  (相対 href は base 補完で www.fanbox.cc になり host 判定を通る。)

- **テスト追加**(tests/dom-helpers.test.ts postIdFromHref describe):
  1. `https://example.com/posts/123` → null(外部ホスト拒否)
  2. `https://twitter.com/posts/456` → null(外部ホスト拒否)
  3. `https://ropy.fanbox.cc/posts/12272980` → `"12272980"`(fanbox サブドメイン許可)
  4. `/@ropy/posts/12272980`(相対) → `"12272980"`(従来どおり許可)

### 完了確認

- `bun run test`: 140 tests(12 files), all green
  - dom-helpers.test.ts: 15 → 18 tests (+3 外部ホスト検査)
- `bun run typecheck`: `tsc --noEmit`, エラー 0
- `bun run build`: 成功
  - dist/content/content-script.js 7.7kb
  - dist/background/service-worker.js 47.9kb
  - dist/options/options.js 12.0kb
  - dist/offscreen/offscreen.js 1.5kb
- core 4 ファイル無変更

### codex-review

実施なし(純粋 helper 単一関数の外部ホスト検査で完結、デザインレビュー必要なし)。
