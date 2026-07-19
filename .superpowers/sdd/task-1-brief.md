### Task 1: リポ雛形 + core 純粋関数コピー(テスト green)

**Files:**
- Create(コピー元 = `/home/shishi/dev/src/github.com/shishi/fantia-dl`、以下 `$FANTIA`):
  - `package.json`(name だけ fanbox-dl に変更)
  - `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `flake.nix`, `.envrc`, `.gitignore`, `.github/renovate.json`, `.github/dependabot.yml`(全て無改造コピー)
  - `src/core/template-engine.ts`, `src/core/sanitizer.ts`, `src/core/path-validator.ts`, `src/core/base64.ts`(無改造コピー)
  - `src/core/types.ts`, `src/core/settings.ts`(いったん無改造コピー。Task 3 で改修)
  - `tests/template-engine.test.ts`, `tests/sanitizer.test.ts`, `tests/path-validator.test.ts`, `tests/settings.test.ts`, `tests/parse.test.ts` → **parse.test.ts はコピーしない**(Task 4 で新規 TDD)。他 4 つは無改造コピー
- 注意: `.envrc` は実行属性が必要(`chmod +x`)

**Interfaces:**
- Consumes: なし(最初のタスク)
- Produces: `renderTemplate(template: string, ctx: RenderContext, opts: {replacement: string; segmentMaxLen: number}): string`(throws `TemplateError`)/ `validatePath(relPath: string, opts: {fullPathMaxLen: number; uniquifyHeadroom: number; conflictAction: string; segmentMaxLen: number}): {ok: true} | {ok: false; error: string}` / `bytesToBase64(b: Uint8Array): string` / `base64ToBytes(s: string): Uint8Array` — 以降の全タスクが利用

- [ ] **Step 1: ファイル群をコピー**

```bash
wsl.exe -e bash -lc '
set -e
F=/home/shishi/dev/src/github.com/shishi/fantia-dl
B=/home/shishi/dev/src/github.com/shishi/fanbox-dl
cd "$B"
mkdir -p src/core tests scripts .github
cp "$F"/tsconfig.json "$F"/vitest.config.ts .
cp "$F"/flake.nix "$F"/.envrc "$F"/.gitignore .
chmod +x .envrc flake.nix
cp "$F"/scripts/build.mjs scripts/
cp "$F"/.github/renovate.json "$F"/.github/dependabot.yml .github/
cp "$F"/src/core/template-engine.ts "$F"/src/core/sanitizer.ts "$F"/src/core/path-validator.ts "$F"/src/core/base64.ts "$F"/src/core/types.ts "$F"/src/core/settings.ts src/core/
cp "$F"/tests/template-engine.test.ts "$F"/tests/sanitizer.test.ts "$F"/tests/path-validator.test.ts "$F"/tests/settings.test.ts tests/
sed "s/\"name\": \"fantia-dl\"/\"name\": \"fanbox-dl\"/" "$F"/package.json > package.json
ls -la'
```

- [ ] **Step 2: 依存をインストールしてテスト実行**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun install && bun run test'
```

Expected: template-engine / sanitizer / path-validator / settings の 4 スイートが全部 PASS(コピーしただけなので green のはず。red なら止まって原因を報告)

- [ ] **Step 3: 型チェック**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run typecheck'
```

Expected: エラー 0(コピーした core は自己完結)

- [ ] **Step 4: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "chore: scaffold repo with fantia-dl toolchain and core pure functions" -m "spec §17 のコピー指針に従い、サイト非依存の core(template-engine/sanitizer/path-validator/base64)をテストごと流用。types/settings は Task 3 で fanbox 用に改修する前提でいったん原本を置く。"'
```

---

