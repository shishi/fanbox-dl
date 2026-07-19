# Task 14: zip モジュール実装完了レポート

## STATUS
✅ **COMPLETE** — 全テスト 16 個 green、型チェック 0 エラー、コミット済み

## 実装概要

### ファイル構成
- **src/background/zip.ts**: 1,221 行
  - `zipEligible(block, s)`: フォト 2 枚以上 + zipGalleries + contentType フィルタ で真偽判定
  - `collectZipSources(files, postId, deps)`: バイト上限 100MB、件数上限 100、allowlist 強制、累積 abort 機構搭載
  - `buildZip(post, block, buffers, s, now)`: 欠落エラー throw、エントリ名衝突は " (n)" 連番回避
  - `downloadZipViaOffscreen(zipPath, bytes)`: 4MB チャンク分割、base64 エンコード、offscreen 委譲
  - `registerZipDownload / handleZipDownloadChange / reconcileZipDownloads`: deps 注入式、interrupted で revoke + 必須文言ログ

- **src/offscreen/{protocol,offscreen}.ts** + **public/offscreen/offscreen.html**: fantia-dl から無改造コピー

- **tests/zip.test.ts**: 16 テストケース
  - `zipEligible`: 4 テスト（条件・否定・フィルタ・ブロック種別）
  - `collectZipSources`: 6 テスト（直列 fetch、累積 abort、事前チェック、件数上限、allowlist、状態コード）
  - `buildZip`: 2 テスト（欠落エラー、衝突回避）
  - `handleZipDownloadChange`: 3 テスト（interrupted ハンドリング、complete、未登録）

### 実装ハイライト
1. **spec §7b 二段階バジェット**:
   - Step (a): 既知サイズ合計が上限超過なら fetch 前に即 error（1 バイトもメモリに保持しない）
   - Step (b): 実行時は累積受信をチャンク単位で計上、超過時点で abort（超過分をメモリに保持しない）

2. **allowlist 強制**: zip ソース fetch も `validateMediaUrl` で一律 deny-by-default

3. **配達経路**:
   - フォールバック: 呼び出し側(Task 15)が個別 DL enqueue + click 通知
   - リトライ: SW → offscreen → blob URL → downloads.download → interrupted 観測 → revoke + console.error ログ
   - 通常完了: revoke のみ（異常ログなし）

4. **競合防止**: offscreenReadyPromise による createDocument の排他制御

5. **永続化**: storage.session で SW 再起動時の blob URL リーク防止、起動時 reconcile で復元

## テスト結果
```
Test Files  17 passed (17)
Tests  144 passed (144)
```
- zip.test.ts: 16 個 100% pass
- 既存テスト: 128 個すべて pass（回帰なし）

## 型チェック
```
tsc --noEmit
```
0 エラー

## コミット
```
60630b8 feat: SW-driven zip pipeline with byte budget and offscreen blob download
```

## 懸念
- 特になし。offscreen 機構は fantia-dl から無改造コピーのため、実績のある実装である。
- Task 15(SW の zip 統合・フォールバック実装)で handleZipDownloadChange は SW の onChanged リスナー内で呼ばれる予定。

## 次のタスク
Task 15: Service Worker 統合 — zip.ts モジュールの呼び出し、フォールバック、ダウンロード change 観測
