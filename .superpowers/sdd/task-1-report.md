STATUS: DONE

COMMIT: d7528b5 chore: scaffold repo with fantia-dl toolchain and core pure functions

TEST RESULTS: 4 test files, 31 tests passed, all green

NOTES:
- Step 1: ファイル群をコピー完了 (toolchain + core pure functions + test suite)
- Step 2: bun install + test実行 → 31 tests passed (template-engine/sanitizer/path-validator/settings スイート全部 PASS)
- Step 3: typecheck → エラー 0 (core は型エラーなし)
- Step 4: git commit → d7528b5 にコミット (23 files, 1005 insertions)

ENVIRONMENT NOTES:
- WSL 環境での npm/bun セットアップ: npm config set prefix で ~/.npm-global に指定してから npm install -g bun
- node_modules は .gitignore に含まれているため stage から除外済み
- flake.lock は fantia-dl で追跡されているため fanbox-dl でもコミット対象
- 全て指定コマンド通りに実行完了、テスト green、型チェック clean
