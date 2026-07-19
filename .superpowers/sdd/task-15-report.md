### Task 15 report: service-worker 配線 + manifest + build 完成

**実行コマンド(抜粋)**

```bash
wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test'
wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run typecheck'
wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run build'
```

**手順**

1. brief 読了・依存モジュール export 確認(ledger/job-store/zip/render-adapter/
   failure-classifier/adoption/fanbox-api/parse/settings/messages)。すべて brief
   の想定シグネチャと一致(差分なし)。
2. Step 1: `public/manifest.json` を完成版(4 permissions・background・
   options_page 参照込み)に、`scripts/build.mjs` を 4 entry
   (content-script / service-worker / options / offscreen)に更新。
3. Step 2: `tests/settle.test.ts` を先に書いて red 確認
   (`Failed to load url ../src/background/settle`) → `src/background/settle.ts`
   実装 → green(5 tests)。
4. Step 3/4: `tests/orchestrator.test.ts` を先に書いて red 確認
   (`Failed to load url ../src/background/orchestrator`) →
   `src/background/orchestrator.ts`(`createOrchestrator(deps)` ファクトリ)実装。
   1回目の実装は brief の Step 3 コードをそのまま deps 化した素直な移植だったが、
   1st の zip フォールバックテストが red のままだった(下記「気づき」参照)。
   fire-and-forget の `startDownload` 完了を `handleDownloadRequest` の応答直前で
   `Promise.all` により待ち合わせるよう調整して green(4 tests)。
5. `src/background/service-worker.ts` を全面置き換え、実 deps で
   `createOrchestrator` を呼ぶ薄い束縛のみに(onMessage の download/clearHistory、
   downloads.onChanged の zip 分岐 + `orchestrator.handleDownloadChanged`、起動時
   `reconcileZipDownloads` + `orchestrator.runStartupReconcile`)。
6. Step 5: 全テスト実行(153 tests green)・typecheck(0 エラー、
   `tests/settle.test.ts` の未使用 import `emptyLedger` を削除して解消)。
   build は `src/options/` が未実装のため `options` entry で解決エラー
   → 一時的に `scripts/build.mjs` から options entry だけ除いたコピーで実行し、
   content/background/offscreen の 3 bundle が生成されることを確認 → その後
   `scripts/build.mjs` を 4 entry(options 込み)の正式版へ復元してコミット
   (Task 16 完了後、そのまま `bun run build` が通る想定)。
7. codex-review(native モード、`--uncommitted`)を実行。指摘は
   「`src/options/options.ts` が無いため build が失敗する」「manifest の
   `options_page` が指す `public/options/options.html` も無い」の 2 件のみ
   (P1/P2)。いずれも brief Step 5 が明示的に予期・許容している Task 16 依存の
   ギャップであり、Task 15 の実装コード(orchestrator/settle/service-worker)
   自体への指摘はゼロ。ここを埋めるための stub ファイル作成は brief の scope
   外(「options がまだ無ければ...一時的に外して green を確認し、その旨を
   報告する」の指示に反する)と判断し、対応は「既知・許容済みとして報告」に
   留めた(2 回連続反復しても同じ結論になることが自明なため追加反復はしていない)。

**テスト結果**

- 全 153 tests green(既存 144 + settle.test.ts 5 + orchestrator.test.ts 4)。
  既存テストの破壊なし。

**型チェック**

- `tsc --noEmit` エラー 0。

**ビルド結果**

- 4 entry のうち options 以外の 3 bundle(`dist/content/content-script.js`,
  `dist/background/service-worker.js`, `dist/offscreen/offscreen.js` +
  `dist/offscreen/offscreen.html`)は正常生成を確認済み(一時的に options entry
  を除いた build.mjs で検証)。
- 正式コミットの `scripts/build.mjs` は 4 entry(options 込み)のままなので、
  現状 `bun run build` は `src/options/options.ts` の解決エラーで失敗する。
  Task 16(options 実装)完了後に再実行すれば 4 bundle 全て生成される想定。

**options entry の扱い**

- brief Step 1 の正規仕様通り、`scripts/build.mjs` には options entry を残して
  コミット(fantia-dl 原本の 4 entry 構成に合わせる)。
- 検証のためだけに entry を一時的に除いたコピーを使い、3 bundle が green で
  生成されることを確認済み(このコピーはコミットしていない)。

**Codex レビュー**

- モード: native / 反復: 1 回
- ステータス: ⚠️ 既知の Task 16 依存ギャップのみ(実装ロジックへの指摘なし)
- 指摘:
  - `scripts/build.mjs:9`: options entry が解決できず build 失敗(Task 16 待ち、
    brief で明示的に許容済み)
  - `public/manifest.json:13`: `options_page` の実体が未実装(同上)

**気づき**

- brief Step 3/Step 4 のコードをそのまま deps 化しただけでは
  `tests/orchestrator.test.ts` の1本目(zip フォールバック→個別 enqueue)が
  timing 起因で red になった。原因は `startDownload()` が
  `void startDownload(j)` の fire-and-forget であるため、
  `handleDownloadRequest` の返り値が確定した直後に `store.read()` すると
  `applyDownloadStarted` の commit がまだ microtask queue 上で解決しておらず
  `state: "pending"` のまま観測されること(実測: `node`/`bun` どちらでも
  純粋 microtask ベースの chain は追加の microtask flush で解決するが、
  `await handleDownloadRequest(...)` 1 回の await だけでは hop 数が足りない)。
  対応として `handleDownloadRequest` 内で `void startDownload(j)` の代わりに
  promise を配列に集約し、応答直前(全 return 経路)で `Promise.all` により
  待ち合わせる `finish()` ヘルパーを追加。`download()` 呼び出し自体は引き続き
  queue の外で行われるため spec §7c-2 のデッドロック防止契約は維持したまま、
  応答の決定性のみを改善した。
- `tests/settle.test.ts` の brief 記載コードに未使用 import
  (`emptyLedger`)があり `noUnusedLocals` で型エラーになったため削除。
