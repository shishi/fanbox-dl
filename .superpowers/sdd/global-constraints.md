## Global Constraints

- **リポ位置**: WSL 内 `/home/shishi/dev/src/github.com/shishi/fanbox-dl`(git 初期化済み・spec コミット済み)。参照実装は `/home/shishi/dev/src/github.com/shishi/fantia-dl`(**読み取り専用。一切変更しない**)。
- **【最重要・Windows 環境の罠】** この環境は Windows の Claude Code から WSL を操作する。**WSL 内パス(`/home/...`)に対して Read/Write/Edit/Glob/Grep ツールを使うことは絶対禁止**(`C:\home\...` という decoy に迷子ファイルができ、本物のリポには何も書かれない)。すべてのファイル操作・コマンドは `Bash` ツールで `wsl.exe -e bash -lc '...'` 経由で行う。ファイル書き込みは「Windows 側 temp に Write → `cat /c/Users/shishi/AppData/Local/Temp/xxx | wsl.exe -e bash -lc 'sed "s/\r$//" > /home/shishi/dev/src/github.com/shishi/fanbox-dl/path/to/file'`」のパイプ方式を使う(CRLF 除去必須)。WSL 内ファイルを読むときは `wsl.exe -e bash -lc 'cat ...'`。
- **コマンド実行**: すべて `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && <cmd>'` 形式。テスト = `bun run test`(vitest run)、型チェック = `bun run typecheck`、ビルド = `bun run build`。
- **conflictAction は `uniquify` 固定**(spec §8)。`overwrite` は**設定値・options UI・
  `chrome.downloads.download` への実引数**のどこにも存在させない。core の path-validator
  (無改造コピー)の型シグネチャや流用テスト内に文字列として残るのは許容(呼び出し側は
  常に `CONFLICT_ACTION` 定数を渡す)。
- **`ZIP_SOURCE_BUDGET_BYTES = 100 * 1024 * 1024`**、zip 件数上限 100、ledger terminal 上限 5,000 件、tombstone 上限 10,000 件、done sweep 1 年(spec §7b/§7c)。
- **識別子規約**(spec §6): identity は `stableContentId`(`"image:{id}"` / `"file:{id}"`)、`idemKey = postId + ":" + stableContentId`。テンプレの `$contentId` はブロック通し番号(`blockOrdinal`)であり identity ではない。`contentId` という名前は render adapter の出力(`RenderContext`)以外に登場させない。
- **core 4 ファイル(template-engine / sanitizer / path-validator / base64)と offscreen zip 生成部は fantia-dl から無改造コピー**(spec §17)。変更が必要に見えたら実装を止めて報告する。
- コミットは Conventional Commits(feat/test/docs/chore)、WHY を body に。各タスク末尾でコミット。
- fantia-dl のコード規約(コメントは日本語で「なぜ」を書く、小さい純粋関数、2 スペースインデント)に合わせる。

---
