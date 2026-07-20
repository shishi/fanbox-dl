## Global Constraints

- **リポ**: WSL 内 `/home/shishi/dev/src/github.com/shishi/fanbox-dl`。ブランチ `impl/mvp`。参照実装 fantia-dl は読むだけ・変更しない。
- **【最重要・Windows 環境】** WSL 内パス(`/home/...`)に Read/Write/Edit/Glob/Grep ツールは**絶対禁止**(`C:\home\...` の decoy 事故)。全ファイル操作・コマンドは `Bash` で `wsl.exe -e bash -lc '...'` 経由。書き込みは「Windows 一時ファイル(`C:\Users\shishi\AppData\Local\Temp\...`)に Write → `cat /c/Users/shishi/AppData/Local/Temp/xxx | wsl.exe -e bash -lc 'sed "s/\r$//" > /home/.../path'`」のパイプ方式(CRLF 除去必須)。WSL 内を読むときは `wsl.exe -e bash -lc 'cat ...'`。
- **bun 実行**: 必ず先頭に `export PATH=$HOME/.npm-global/bin:$PATH`。テスト=`bun run test`、型チェック=`bun run typecheck`、ビルド=`bun run build`。全コマンド `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && <cmd>'`。
- **conflictAction は `uniquify` 固定**(`CONFLICT_ACTION` 定数、`src/core/settings.ts`)。overwrite を設定値・options UI・download 実引数に出さない。
- **core 無改造**: `src/core/template-engine.ts` / `sanitizer.ts` / `path-validator.ts` / `base64.ts` は変更しない(fantia-dl バイト一致)。`settings.ts` / `types.ts` / `url-allowlist.ts` は本プロジェクトのもので変更可。
- **allowlist は全ネットワーク使用前に必須**(`validateMediaUrl(url, postId)`、`src/core/url-allowlist.ts`)。zip ソース fetch は `redirect:"error"`。
- **リダイレクト検出(fail-closed)**: 通常 DL 完了時に finalUrl を allowlist 再検証。item/finalUrl が取れない場合も「検証済み」にせず破棄+通知に倒す。
- コミットは Conventional Commits、WHY を body に。各タスク末尾でコミット。

## 削除するファイル(dedup/耐久性の存在理由が消えるもの)

`src/background/ledger.ts`, `job-store.ts`, `mutation-queue.ts`, `adoption.ts`, `settle.ts`, `failure-classifier.ts`, `src/core/canonical-relpath.ts` と対応テスト
`tests/ledger-enqueue.test.ts`, `tests/ledger-lifecycle.test.ts`, `tests/job-store.test.ts`, `tests/mutation-queue.test.ts`, `tests/adoption.test.ts`, `tests/settle.test.ts`, `tests/failure-classifier.test.ts`, `tests/canonical-relpath.test.ts`。

## 維持するファイル(無改造 or 軽微)

`src/core/{template-engine,sanitizer,path-validator,base64}.ts`(無改造)、`src/core/url-allowlist.ts`(無改造)、`src/background/render-adapter.ts`(無改造)、`src/offscreen/*`(無改造)、`src/fanbox/api.ts`(無改造)。対応テストも維持。

---
