# Task 1: バックエンドの fire-and-forget 化 — 実施報告

## 概要
ledger/job-store/mutation-queue/adoption/settle/failure-classifier/canonical-relpath(7 モジュール)
と対応テスト 8 本を削除し、型(`FileItem`/`PostData` から identity・updatedAtIso 撤去)・
`parse.ts`(idemKey/stableContentId/refetch 生成を撤去、post 内重複スキップは維持)・
`zip.ts`(buffers キーを idemKey→url)・`messages.ts`(force・ClearHistoryMessage 撤去)・
`orchestrator.ts`(全面書き換え: 受領 json 検証→parse→allowlist→chrome.downloads.download
(uniquify)の投げっぱなし。redirect map は downloadId→postId の揮発 Map + onChanged で
finalUrl を fail-closed 再検証するためだけに軽量維持)・`service-worker.ts`(全面書き換え:
薄い束縛のみ、起動時は reconcileZipDownloads + loadRedirectMap のみ)を実装した。

## brief からの逸脱(必須の追加修正)
brief の Modify/Delete リストには含まれていなかったが、`messages.ts` の
`DownloadRequestMessage` から `force` フィールドを撤去した結果、
`src/content/content-script.ts` が壊れる(型エラー: 'force' does not exist /
excess property)ため、ビルド緑化に必須の最小修正として同ファイルを変更した:
- `runDownload(force: boolean)` → `runDownload()`(force 引数を撤去)
- SW へ送るメッセージリテラルから `force,` を削除
- 2 箇所の呼び出し `runDownload(false)` / `runDownload(true)` → `runDownload()`

UI(ボタン文言・retry ボタンの要否)自体の整理は着手していない
(タスクリスト項目 #6「変更(履歴撤去+ボタン)の実装プラン作成」で別途計画済みのため、
本タスクでは型整合の最小修正に留めた)。`src/options/options.ts` は
`chrome.runtime.sendMessage({ kind: "clearHistory" })` を型付けなしで呼んでおり
コンパイルには影響しないため無変更。SW 側で `clearHistory` kind のハンドラが
無くなったことで、このボタンは実行時に無反応になる(エラーにはならない)。

## 確認結果
- `bun run test`: 12 test files / 112 tests all green(parse 11・zip 22・
  orchestrator 7・render-adapter 5 含む全緑)。
- `bun run typecheck`: エラー 0。
- `bun run build`: 4 エントリ(content-script/service-worker/options/offscreen)成功。
- core 無改造確認: `git diff --stat HEAD -- src/core/template-engine.ts
  src/core/sanitizer.ts src/core/path-validator.ts src/core/base64.ts` は空
  (無変更)。

## コミット
`refactor: remove dedup/history machinery, make downloads fire-and-forget`
