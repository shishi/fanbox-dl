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
