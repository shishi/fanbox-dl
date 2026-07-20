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
