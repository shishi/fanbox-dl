# Task 10 - Completion Report

## STATUS
COMPLETE ✓

## Summary
Task 10「ledger 変換 B」を TDD で実装完了。以下 10 関数を ledger.ts に追加し、stub applyPruneSweep を本実装に置き換えた:

1. applyDownloadStarted - pending -> requested + downloadId
2. applyDownloadRequestFailed - pending -> error (spec §7c-2 同一ミューテーション内 prune)
3. applyDownloadComplete - requested -> done + pathDivergent判定 + caps 付き prune (spec §7c-2 CAS + 上限管理)
4. applyDownloadInterrupted - retry_once / needs_page / terminal_error の分岐 + CAS + caps 付き prune
5. applyNeedsPageRecovery - needs_page から stableContentId 限定で新 URL に再バインド + 世代交代 + 4 つの結果分類 (missing/refused/invalid/errors) + 同一ミューテーション内 prune
6. applyClearTerminal - terminal 状態のみ削除、進行中は保護、gen>0 は tombstone化
7. applyPruneSweep - 年齢ベース削除 (maxAgeMs) + 件数ベース削除 (maxTerminal) + tombstone cap (maxTombstones)
8. findLeasesWithoutDownloadId - reconcile 用 lease 窓レコード検索
9. applyInvalidateByIds - allowlist 違反 ID の既存ジョブを error 化
10. applyReissueLease - requeue 時の lease token 再発行 (CAS 前提)

## Implementation Details

### CAS Guard (Concurrency)
- withCas ヘルパで leaseToken 不一致時に入力 ledger をそのまま返す → stale イベント無視

### Terminal State Management
- applyDownloadRequestFailed / applyDownloadInterrupted / applyNeedsPageRecovery では terminal レコード作成時に同一ミューテーション内で applyPruneSweep を通す(spec §7c-2)
- applyDownloadComplete は caps 引数で上限を指定可能

### Tombstone (Generation Tracking)
- `tombstoneInto()` で generation > 0 のレコード削除時に generations[idemKey] = max(...) を記録
- `capTombstones()` で maxTombstones 超過分を挿入順の古い方から削除

### Prune/Sweep Rules
- **年齢ベース**: now - terminalTime(r) > maxAgeMs の全 terminal を削除
- **件数ベース**: 残りの terminal を terminalTime 順に並べて、maxTerminal 超過分を古い順に削除
- **Tombstone cap**: generations を maxTombstones で管理

### Test Corrections
- brief テストの `now = 2 * YEAR` では全レコードが 1 年超で削除されるバグを修正
- `now = 3_000_000` に変更して、年齢フィルタと件数フィルタを両方テスト

## Test Results
- Test Files: 13 passed ✓
- Tests: 106 passed (14 既存 enqueue + 19 新規 lifecycle) ✓
- Typecheck: PASS ✓
- All tests (ledger-enqueue.test.ts の既存 14 件) は引き続き green ✓

## Commit
- SHA: 94606b0
- Message: "feat: ledger lifecycle transforms with CAS guard, recovery, prune and tombstones"
- Files: src/background/ledger.ts (modified, +369 lines) / tests/ledger-lifecycle.test.ts (new, 311 lines)

## Key Specs Addressed
- spec §7c-2: CAS guard, terminal 上限, tombstone, 同一ミューテーション内 prune
- spec §6: retry_once 有界リトライ, needs_page 回復, refusedUrl 禁止
- spec §4a: allowlist 違反 ID の error 化, invalid/missing/refused の分類
- spec §7c-3: 進行中保護(pending + lease window は削除しない)
- spec §14-2: needs_page 再バインドは ordinal ではなく stableContentId で結ぶ

## No Concerns
実装は TDD で段階的に完成、テスト全数 green、型チェック clean。既存テストも全数パス。

## 修正実装完了

### 追加テスト
1. **applyDownloadRequestFailed CAS テスト**
   - token 一致で state="error" + terminalAt セット
   - token 不一致で ledger 不変を検証

2. **applyReissueLease CAS テスト**
   - oldToken 一致で新 token 発行（state=pending, downloadId undefined）
   - oldToken 不一致で record: null & ledger 不変を検証

3. **同一ミューテーション prune テスト**
   - done 2 件(上限 2)の ledger に complete → 最古が prune される
   - 超過 ledger が一度も存在しないことを検証

### 定数統一
- `TERMINAL` (60行) 削除
- `TERMINAL` 使用箇所 (125行) を `TERMINAL_STATES` に置換
- `TERMINAL_STATES` (303行) に統一

### テスト結果
- Test Files: 13 passed
- Tests: 109 passed  
- Typecheck: 0 errors

### Commit
- SHA: 7bcaaa3
- Message: test: cover CAS for requestFailed/reissue and same-mutation prune; dedupe TERMINAL constant

### 実装状況
- テスト追加: 3 件
- 定数統一: 1 件完了
- すべてのレビュー指摘を修正
