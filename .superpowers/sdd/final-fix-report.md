# Final review fixes — report

Commit: `b62a478` — "fix: revalidate finalUrl on reconcile, classify adopted interrupted, guard invalid settings save (final review)"

All 3 fixes were implemented with TDD (failing test first, verified RED, then minimal
implementation, verified GREEN). After the initial 3 fixes, the change was run through
`codex-review` (native mode) 4 times; rounds 2 and 3 found real gaps introduced by the
round-1 fixes themselves, which were fixed and re-reviewed until codex reported clean
("I did not find any introduced defects...").

## Fix 1 (P1) — orchestrator.ts: finalUrl allowlist revalidation on reconcile

`handleDownloadChanged`'s complete branch already revalidated `finalUrl` via
`validateMediaUrl` before accepting a download as `done` (redirect defense, spec §4a-3).
`runStartupReconcile` had two more complete-transition paths that skipped this check:
the crash-window adoption branch and the `requested`-reconcile branch.

Extracted a shared pure helper `finalizeComplete(l, rec, token, item, now)` in
`src/background/orchestrator.ts` and used it in all three complete-transition sites:

- `handleDownloadChanged`'s complete branch
- `runStartupReconcile`'s crash-window adoption complete branch (fetches the full
  `DownloadItem` via a second `search({id})` to get `finalUrl`)
- `runStartupReconcile`'s `requested`-reconcile complete branch (reuses the `d` already
  fetched)

Round 2 codex finding: when the crash-window branch's second `search({id: hit.id})`
races and returns nothing, falling back to `hit.url` (the pre-redirect request URL,
always allowlisted) would silently reopen the redirect bypass. Fixed by failing
closed: if the second lookup misses, the job is marked `error` (not `done`) instead of
guessing.

Tests added in `tests/orchestrator.test.ts`:
- reconcile via crash-window adoption: complete + disallowed `finalUrl` → `error`, not `done`
- reconcile via `requested` path: complete + disallowed `finalUrl` → `error`, not `done`
- crash-window adoption: second id-lookup races (returns `[]`) → fail-closed `error`,
  not `done` with a fabricated finalUrl

## Fix 2 (P2) — settle.ts: classify adopted-interrupted immediately instead of dead-waiting

`settleInFlight`, when a promise is lost and `findAdoptable` finds an already-
`interrupted` browser download, used to record it as `requested` and fall into the
generic "cancel + wait up to 10s for terminal" loop — which can never succeed (the
download is already terminal in Chrome and nothing will move it further), so it always
timed out.

Now it fetches the full item (`search({id: hit.id})`) and, if available, classifies via
`classifyDownloadError` and calls `applyDownloadInterrupted` immediately (same pattern
as the reconcile crash-window interrupted branch), instead of waiting.

Round 2 codex finding: naively reusing `classifyDownloadError`'s `retry_once` outcome
would leave the job `pending` with a fresh lease but nothing actually re-downloading it
— `settleInFlight` would report success while the job silently never proceeds. Fixed by
treating `retry_once` as `terminal_error` in this settle-only context (settle has no way
to actually kick off the retry the way `onChanged`/reconcile can; the immediately-
following force re-enqueue will start a fresh download for the same content anyway, so
nothing is functionally lost).

Round 3 codex finding: if the second `search({id})` races and returns nothing, the
original round-2 fix defaulted to a generic `"interrupted"` reason, silently downgrading
a possible `SERVER_FORBIDDEN` to a plain terminal error and losing `refusedUrl` (which
blocks auto-reissue of a known-refused URL). Fixed by *not* guessing: when the second
lookup misses, control falls through to the pre-existing generic cancel+bounded-wait
path instead, so the failure becomes a visible timeout error rather than an incorrectly
classified terminal state.

`SettleDeps` gained an optional `newLeaseToken?: () => string` (defaults to an internal
fallback so existing tests/call sites needed no changes); `orchestrator.ts` now passes
its real `newLeaseToken` through.

Tests added in `tests/settle.test.ts`:
- promise lost + adoption finds `interrupted` → classified immediately, no 10s timeout
- promise lost + adoption finds `interrupted` with `NETWORK_*` (retry_once) → forced to
  `error`, never left `pending`
- adoption finds `interrupted` but the second id-lookup races (`[]`) → falls back to the
  bounded-wait path (explicit timeout error), `refusedUrl` not fabricated

## Fix 3 (P2) — options.ts: guard save when template/path validation has errors

Extracted the DOM-independent parts of the preview computation into a new pure module
`src/options/validate-templates.ts` (`checkTemplate`, `hasTemplateError`,
`hasBlockingTemplateError`), since the options layer has no DOM test harness
(`vitest.config.ts` uses `environment: "node"`, no jsdom) but the validation logic
itself is pure and testable.

The save click handler now recomputes validation at click time (not trusting stale DOM
text) and refuses to call `saveSettings` if there's a blocking error, showing
`alert("テンプレートにエラーがあります。修正してください")` instead.

Round 3 codex finding: the initial guard blocked saving on *any* of the 3 template
previews having an error, including the zip path/entry templates — but those are only
ever used when `zipEligible()` would apply (`zipGalleries` checked AND
`contentTypes.photo` checked). A user disabling zip mode (or any unrelated setting)
while having a stale/invalid zip template could no longer save anything. Fixed with
`hasBlockingTemplateError(main, { zipModeActive, zipPath, zipEntry })`, which only
treats zip-template errors as blocking when zip mode is actually active at save time;
the main path template's errors always block.

Tests added in `tests/options-validate-templates.test.ts` (new file, pure-logic unit
tests, no DOM):
- `checkTemplate`: valid template → no error; unknown placeholder → template error;
  path exceeding effective max length → path-validation error (distinguished from
  template error)
- `hasTemplateError`: true iff any input errors
- `hasBlockingTemplateError`: main-template error always blocks; zip-template errors
  only block when `zipModeActive`; all-valid → never blocks

The `options.ts` click-handler wiring itself (DOM event binding) has no dedicated test
(no DOM harness in this repo), but all the actual decision logic it calls is now pure
and unit-tested. Manually reasoned through the DOM wiring by inspection; not run in a
live browser.

## Test / typecheck / build commands and final output

```
$ bun run test
 Test Files  20 passed (20)
      Tests  167 passed (167)

$ bun run typecheck
$ tsc --noEmit
(0 errors)

$ bun run build
$ bun scripts/build.mjs
  dist/content/content-script.js  5.3kb
  dist/background/service-worker.js  72.3kb
  dist/options/options.js  12.5kb
  dist/offscreen/offscreen.js  1.5kb
build done
```

## codex-review iterations (native mode, `--uncommitted`)

1. Round 1 (initial 3 fixes): 2 findings (P2 orchestrator.ts fallback-to-hit.url race,
   P2 settle.ts retry_once left pending) — fixed.
2. Round 2: exact same 2 areas flagged again because the round-1 fixes' fallback
   choices had their own gaps (see Fix 1/Fix 2 "round 2 finding" above) — fixed with
   fail-closed redesign instead of optimistic fallback guessing.
3. Round 3: 1 finding, options.ts save guard blocking unrelated saves when zip mode is
   off (see Fix 3 "round 3 finding" above) — fixed.
4. Round 4: clean — "I did not find any introduced defects that would likely break
   existing behavior or require follow-up fixes."

## Files changed

- `src/background/orchestrator.ts`
- `src/background/settle.ts`
- `src/options/options.ts`
- `src/options/validate-templates.ts` (new)
- `tests/orchestrator.test.ts`
- `tests/settle.test.ts`
- `tests/options-validate-templates.test.ts` (new)


## Whole-branch review round 2 — 3 fail-closed gaps (this session)

A subsequent whole-branch codex native review (round 2 of the whole-branch
gate, distinct from the per-commit rounds above) found 3 more fail-closed
gaps, all in the redirect/finalUrl-revalidation and interrupted-reason-
preservation family:

### Fix A (P1) — `orchestrator.ts` `finalizeComplete` fallback to `rec.url`

`finalizeComplete` computed `finalUrl = item?.finalUrl || item?.url || rec.url`.
When `chrome.downloads.search({ id })` races empty (e.g. history cleared
concurrently), `item` is `undefined` and the code fell back to `rec.url` —
the original, already-allowlisted request URL — so the allowlist check
always passed and the job was marked `done` without ever confirming the
real `finalUrl`. Fixed by dropping the `rec.url` fallback entirely: if
`item?.finalUrl ?? item?.url` is unavailable, the job is not marked
`done` — it goes to `error` via `applyDownloadInterrupted(..., "terminal_error",
"完了を確認できませんでした(finalUrl 未確認)", ...)`, recoverable by the user
re-clicking. This single fix, because `finalizeComplete` is the shared
helper for all three completion call sites (`handleDownloadChanged`
complete branch, crash-window adoption complete branch, and `requested`
reconcile complete branch), closes the hole uniformly across all of them;
the crash-window branch's separate ad-hoc "search empty" handling was
removed in favor of routing through the same helper.

Test added: `tests/orchestrator.test.ts` — "onChanged: complete だが
search({id}) が空(履歴クリア等のレース)なら done にせず error にする
(finalUrl 未確認) (最終レビュー修正2 Fix A)".

### Fix B (P1) — `settle.ts` `settleInFlight` adopting `complete` without any finalUrl check

When `settleInFlight` lost the in-flight promise and `findAdoptable` found
a `complete` item, the code called `applyDownloadComplete` using only
`hit.filename` — no `finalUrl` check against the allowlist at all (unlike
the reconcile path, which already had `finalizeComplete`). Fixed by
re-fetching the full item via `deps.search({ id: hit.id })`, resolving
`finalUrl = full?.finalUrl ?? full?.url`, and validating with
`validateMediaUrl(finalUrl, rec.postId)` (imported from
`../core/url-allowlist`) before marking `done`; on failure it goes to
`error` via `applyDownloadInterrupted(..., "terminal_error", "ダウンロード
が許可外 URL にリダイレクトされました", ...)`. `SettleDeps.search`'s return
type was widened with an optional `finalUrl` field.

Test added: `tests/settle.test.ts` — "promise 喪失 + adoption した complete
の finalUrl が allowlist 外(redirect)なら done にせず error にする (最終
レビュー修正2 Fix B)".

**Round-2 finding on this same fix (codex re-review):** the first version
of Fix B still fell back to `hit.url` (the original request URL, not a
verified `finalUrl`) when the follow-up `search({ id: hit.id })` itself
raced empty — reopening the exact same hole Fix A had just closed
elsewhere. Fixed by removing the `hit.url` fallback too: if `full` (or its
`finalUrl`/`url`) is unavailable, the job fails closed to `error`
("完了を確認できませんでした(finalUrl 未確認)") instead of being adopted as
`done`.

Test added: `tests/settle.test.ts` — "promise 喪失 + adoption した complete
の実体再取得(id 指定)が空(race)なら hit.url にフォールバックせず done に
せず error にする (codex レビュー指摘 最終レビュー修正2 round2)".

### Fix C (P2) — `orchestrator.ts` crash-window adopted-interrupted reason loss

In the crash-window adoption branch, when the adopted `hit` was
`interrupted` and the follow-up `search({ id: hit.id })` raced empty,
`reason` was resolved as `d?.error ?? "interrupted"` — discarding
`hit.error` (e.g. `SERVER_FORBIDDEN`) captured at adoption time, so the
job lost the explicit "未加入の有料コンテンツの可能性" wording and its
`refusedUrl` guard against auto-requeue. Fixed by resolving
`reason = d?.error ?? hit.error ?? "interrupted"`, and adding an optional
`error?: string` field to `DownloadItemLike` (`adoption.ts`) plus
`error: d.error` in the `items.map(...)` that builds adoption candidates
in both `orchestrator.ts` and `settle.ts`, so `hit.error` is actually
populated from the original search result.

Test added: `tests/orchestrator.test.ts` — "起動時 reconcile: crash-window
adoption した interrupted の hit が error(SERVER_FORBIDDEN) を持つ場合、
実体再取得(id 指定)が空でも reason を失わず refusedUrl が付く (最終レビュー
修正2 Fix C)".

### Verification

- `bun run test`: all green (171 tests, 20 files after the round-2 addendum
  test; 170/20 immediately after Fixes A/B/C).
- `bun run typecheck`: 0 errors.
- `bun run build`: succeeds (service-worker bundle grew slightly,
  72.8kb → 73.1kb).
- codex native review (uncommitted diff, round 2 of whole-branch gate):
  first pass flagged the `hit.url` fallback gap in Fix B (P2); after
  fixing it, second pass returned "I did not find a discrete, actionable
  regression in the modified code paths, and the existing test suite
  passes with these changes." — clean.

### Files changed (this round)

- `src/background/adoption.ts` (added `error?: string` to `DownloadItemLike`)
- `src/background/orchestrator.ts`
- `src/background/settle.ts`
- `tests/orchestrator.test.ts`
- `tests/settle.test.ts`

Commit: `242915c` — "fix: uniform fail-closed finalUrl revalidation across
all completion/adoption paths + preserve interrupted reason (final review
round 2)"

## Final review round 3 (P2/P3 残り2件)

- コミット: 5b996cd fix: neutralize path separators in placeholder values at adapter; reject invalid illegalCharReplacement (final review round 3)
- P2: render-adapter.ts に純粋関数 `neutralizePathSeparators(s)` を追加し、buildRenderContext/buildZipRenderContext が
  creator/creatorId/postTitle/contentType/plan/filename/ext を RenderContext に格納する前に / と \ を _ に中和するよう変更。
  tests/render-adapter.test.ts に「値に / や \ を含むとサブフォルダ化しない」テスト3件を追加(TDD: RED確認後にGREEN)。
- P3: src/options/validate-templates.ts に純粋関数 `illegalReplacementError(rep)` を追加(/ か \ を含めば日本語エラー、
  空文字は options.ts 側の "_" フォールバック契約により null)。tests/options-validate-templates.test.ts に6件追加。
  options.ts の save ハンドラで既存の hasBlockingTemplateError ガードに加えて illegalReplacementError もチェックし、
  エラーなら alert して保存拒否するよう変更。
- codex native レビュー(1回目)で追加指摘: options.ts の保存ガードは新規保存しか防がず、旧バージョンからの引き継ぎ・
  他ブラウザ同期で既に永続化された illegalCharReplacement が / や \ を含む場合、production の render 経路
  (orchestrator.ts の handleDownloadRequest)がそのまま core の renderTemplate に渡してしまい、P2 の中和効果が
  sanitizeSegment の置換文字挿入によって無効化される実害パスが残っていた(core は無改造のため split → sanitize の
  順序は変えられない)。
  - TDD で再現テストを追加(tests/orchestrator.test.ts: postTitle に ":" を含め、illegalCharReplacement="/" を
    持つ設定で handleDownloadRequest を呼ぶと relPath のセグメント数が想定より1つ多くなることを確認 → RED)。
  - orchestrator.ts の handleDownloadRequest 冒頭(loadSettings 直後の唯一の呼び出し箇所)で
    `neutralizePathSeparators(loaded.illegalCharReplacement)` を適用してから s として以降(renderTemplate と
    zip.build 双方が共有する同一 Settings オブジェクト)に流すよう修正 → GREEN。
  - codex native レビュー(2回目)で新たな指摘: この修正により既存(旧挙動由来)の永続化済みジョブの basePath が
    変わり得るため、次回クリック時に applyEnqueue の dedup 判定(`prev.relPath === canonicalRelPath(...)`)が
    外れて新 generation の重複 DL が発生し得る、という P2 指摘。ただしこれは uniquify の「無言上書きが構造的に
    起きない」という既存設計契約(spec §7c-2/§8、core 無改造)そのものであり、path テンプレ編集など他の
    設定変更でも同様に発生する既知・容認済みのトレードオフ(core/ledger の dedup/migration ロジックへの変更は
    本タスクのスコープ外 かつ core 無改造制約に抵触)。本ラウンドでは対応せず、懸念事項として記録するのみとした。
- 完了確認: `bun run test` 181 tests green(ベースライン171 → +10: render-adapter +3, options-validate-templates +6,
  orchestrator +1)。`bun run typecheck` 0 errors。`bun run build` 成功(4 entry: content-script/service-worker/options/offscreen)。
- core(src/core/*)無変更確認: `git diff --stat f5024dc..HEAD -- src/core` は空(直前コミットからの差分ゼロ)。
  `git diff --stat 7865aaa..HEAD -- src/core` は 7865aaa(docs専用ベースライン)以降に追加された core ファイル群の
  総追加行のみを示し、削除/変更行は無い(= 実装コミット群を通じて core は一貫して無改造)。


## Final review round 4 (P1/P2 残り2件)

- コミット: 342c394 fix: clear stale lease-only nonterminals on history clear; abort offscreen accumulation on zip chunk failure (final review round 4)

### P1 — ledger.ts applyClearTerminal: 履歴クリアで復旧できない stale nonterminal

`applyClearTerminal` は従来 pending/requested を無条件に残していた(spec §7c-3: 進行中の
browser DL を孤児化しないため)。しかし `downloadId === undefined` の nonterminal は
browser 側にまだ download() が成功/永続化されていない lease-only の残骸であり、fail-closed
復旧(「履歴を全部クリア」)がこの stale レコードに阻まれて `applyEnqueue` のブロックを
解消できないケースがあった。

TDD で `tests/ledger-lifecycle.test.ts` に失敗テストを追加(downloadId 無しの pending は
削除される / downloadId 有りの requested は残る)、RED 確認後、`applyClearTerminal` に
「downloadId undefined の nonterminal も削除(gen>0 は tombstone)、downloadId を持つ
nonterminal は従来どおり保持」の分岐を追加して GREEN にした。

**codex native レビューで追加指摘(1件)**: `download()` はキューの外(spec §7c-2 デッド
ロック防止)、つまり enqueue のコミットと `applyDownloadStarted` のコミットの間に非同期の
空白期間がある。この実装では、その空白期間中(download() 呼び出しがまだ解決していない
だけ)に履歴クリアが走ると、`downloadId === undefined` というだけで生きた DL のレコードを
削除してしまい、後から届く `applyDownloadStarted` は CAS で no-op になって downloadId が
永続化されず、DL が孤児化(再クリックで同一ファイルの二重 DL)し得るという回帰。

これに対し、`applyClearTerminal` に `now: number` 引数を追加し、`leasedAt` から 10 秒
(既存の `settle.ts` の bounded-wait と同じ目安)の猶予期間を設け、「猶予期間内の
downloadId 無し nonterminal は残す(競合窓の保護)」「猶予期間を過ぎてもなお downloadId が
付かない場合のみ stale とみなして削除する」よう修正。`service-worker.ts` の呼び出し側は
`applyClearTerminal(l, Date.now())` に更新。

テスト追加(`tests/ledger-lifecycle.test.ts`):
- 猶予期間(10s)を過ぎても downloadId 無しの pending は削除される(gen 0 は tombstone
  化しない/ gen>0 は tombstone 化される、の 2 パターン)
- 猶予期間内は downloadId 無しの pending でも削除しない(codex 指摘の競合窓保護)
- downloadId 有りの requested は猶予期間経過後も削除されない
- downloadId 付きの進行中(image:b)は terminal 削除・tombstone 化と混在しても残る

### P2 — zip.ts downloadZipViaOffscreen: zip チャンク送信失敗時の offscreen リーク

チャンク送信ループ(`sendChunkToOffscreen`)が `zipDone` 前に reject すると、offscreen
document の `accumulators`(jobId ごとの Uint8Array 蓄積、常駐ページなので破棄されない
限り残り続ける)にチャンクが居座ってリークする問題があった。

修正: チャンク送信ループ〜`finishZipDownload` を try で囲み、途中で失敗したら offscreen へ
`zipAbort(jobId)` を送って蓄積を破棄してから `{ ok: false, error }` を返すようにした。
`zipAbort` メッセージ自体・offscreen 側の `zipAbort` ハンドラ(`accumulators.delete`)は
既に存在していた(fantia-dl 由来)ため、新規に必要だったのは送信側(service worker)からの
呼び出し配線のみ。

テスト容易化のため `ZipOffscreenDeps`(`ensureOffscreen`/`sendChunk`/`finish`/`abort`)を
`downloadZipViaOffscreen` の第3引数として注入可能にし(省略時は実 chrome API を使う既定
実装)、`tests/zip.test.ts` に以下をユニットテストとして追加(offscreen 実体は使わず、
deps を差し替えて検証):
- チャンク送信が zipDone 前に失敗 → zipAbort が送られ、finish には到達しない
- finish(zipDone)自体が失敗 → zipAbort が送られる
- 正常系 → zipAbort は送られない

手動確認は不要だった(deps 注入で完全にユニットテスト可能だったため)。

### 完了確認

```
$ bun run test
 Test Files  20 passed (20)
      Tests  187 passed (187)

$ bun run typecheck
$ tsc --noEmit
(0 errors)

$ bun run build
$ bun scripts/build.mjs
  dist/content/content-script.js  5.3kb
  dist/background/service-worker.js  74.2kb
  dist/options/options.js  12.9kb
  dist/offscreen/offscreen.js  1.5kb
build done
```

core(src/core/*)無変更確認: `git diff --stat 7865aaa..HEAD -- src/core` は追加のみ
(insertions 323、deletions 0)で、7865aaa(docs専用ベースライン)以降 core は一貫して
追加されただけで変更されていないことを確認した。

### codex-review (native, `--uncommitted`) 反復

1. 1回目: P1 指摘 1件(上記「competing race window」)— 修正。
2. 2回目(再レビュー): clean — 「I did not identify any discrete regressions in the
   modified code paths. The changes are covered by targeted tests, and the updated
   behavior appears internally consistent with the surrounding download and cleanup
   logic.」

### 懸念事項

- 猶予期間(10s)は `settle.ts` の既存 bounded-wait と同じ目安値を流用した経験則であり、
  極端に遅い `chrome.downloads.download()`(端末・拡張機の負荷等)ではこの窓を超える
  可能性は理論上ゼロではない。ただし当該経路は元々 SW クラッシュ等からの手動復旧
  (履歴クリア)を想定したものであり、ユーザーが数秒〜分オーダーで気づいて操作する
  現実的なタイムスケールに対しては十分な安全マージンと判断した。
- P2 の offscreen リーク修正は deps 注入によるユニットテストで検証したが、実際の
  Chrome offscreen document / `chrome.runtime.sendMessage` を使った統合的な手動確認は
  行っていない(依頼文の「offscreen 実体はテスト困難なので…難しければ手動確認で可」の
  代替として deps 注入テストを選択したため)。

## 最終レビュー round5 P2 (3件) 修正 — needs_page 回復の zip/設定尊重 + zip entryPath 実行時検証

対象コミット: dac7c00 (branch: impl/mvp)

### 修正内容

**P2a/P2b (orchestrator.ts): needs_page 回復が現在の zip/contentType 判断を尊重する**

- `handleDownloadRequest` の needs_page 回復ステップで使う `fresh` を、
  「zipEligible(block, settings) が false」かつ「s.contentTypes[file.contentType] が有効」な
  ファイルだけに限定した。zip 予定ブロックのファイルと、無効化された contentType の
  ファイルは `excludedStableIds` として除外する。
- core の `applyNeedsPageRecovery` は「fresh に無い stableContentId = 投稿編集で消えた」と
  解釈して missing/error に倒すため、除外分の既存 needs_page レコードは commit 前に
  スナップショットを取っておき、commit 後に元の状態(needs_page のまま)へ復元する
  (core 無改造で「回復しない」を実現)。
- codex レビューでの追加指摘(反復 1 回目・P2): zip 予定は静的な設定判定にすぎず、
  実行時に collect/build/downloadViaOffscreen が失敗して個別 DL にフォールバックする
  ケースがある。フォールバック時に据え置いた needs_page レコードをそのまま
  candidates ループに流すと、core の正規の回復ロジック(同一 URL は拒否 / URL 変更は
  世代交代)を経ないまま applyEnqueue の「非回復 needs_page 再クリック」分岐
  (同世代・無条件再投入)に落ちてしまい、拒否済み URLの黙った再試行や、世代が
  上がらないままの再投入を招くことが分かった。ブロックループ側で実際に zip が
  不成立だったブロックに限り、その場で block スコープの `applyNeedsPageRecovery` を
  もう一度掛け直すことで解決した。
- codex レビューでの追加指摘(反復 2 回目・P1/P2): この block スコープの再回復呼び出しは
  `applyNeedsPageRecovery` が postId 全体の needs_page を走査する性質上、
  まだ処理順が回ってきていない他ブロック(他の zip 予定ブロックや contentType 無効化分)の
  据え置き中レコードまで missing 化してしまう不具合と、basePath の renderTemplate 呼び出しが
  TemplateError を素通しして throw する回帰があった。前者は phase 1 と同じ
  「復元スナップショット」パターンをブロックスコープでも適用し、後者は後段の候補ループと
  同じ try/catch(テンプレートエラー応答 + finish())に統一して解消した。

**P2c (zip.ts): buildZip の entryPath 実行時検証**

- `buildZip` で各ファイルの entryPath(衝突回避の連番付与後)に対し、zipPath と同じ
  `validatePath` を適用し、不正(先頭 `/`、`..` セグメント、パス長超過等)なら
  fail-closed で throw するようにした(呼び出し側 `handleDownloadRequest` の
  zip build try/catch が個別 DL フォールバックに乗せる)。
- codex レビューでの指摘: zip 内部のエントリ名は chrome.downloads の uniquify
  サフィックス対象ではない(実ファイルシステムパスではない)ため、
  `conflictAction: CONFLICT_ACTION`(= "uniquify")を渡すと `uniquifyHeadroom`
  (既定 16)が誤って差し引かれ、実際には収まる長さの entry まで誤検知で拒否する
  regression になっていた(再現テストで確認)。`conflictAction: "overwrite"` を渡すことで
  headroom を差し引かず、トラバーサル系のチェック(先頭 `/`、`..` セグメント等)は
  そのまま有効にした。

### テスト(TDD: 全て RED 確認後に実装 → GREEN)

- `tests/orchestrator.test.ts`
  - 「zip 予定ギャラリーに needs_page があっても回復で個別 DL は始まらず zip 1 本だけになる」
  - 「video を無効化した後は video の needs_page が回復再開されない」
  - 「zip 予定だが実際には zip 化に失敗して個別 DL にフォールバックする場合、changed-URL の
    needs_page は generation を上げて正しく回復する」(codex 指摘の再現 → 修正確認)
  - 「zip 予定だが実際には zip 化に失敗して個別 DL にフォールバックする場合、same-URL の
    needs_page は再試行されず明示 error になる」(codex 指摘の再現 → 修正確認)
  - 「複数ブロックの投稿で、あるブロックの zip フォールバック回復が他ブロックの据え置き
    needs_page を誤って missing 化しない」(codex 指摘の再現 → 修正確認)
- `tests/zip.test.ts`
  - 「entryPath が ../ を含むと buildZip が throw する」
    (renderTemplate は通常経路では `../` を無害化するため、zipEntryTemplate 呼び出しだけを
    狙った vi.mock マーカーテンプレで実行時検証層を独立にテストした)
  - 「entryPath の実行時検証はダウンロードパスの uniquify headroom を誤って流用しない」
    (codex 指摘の再現 → 修正確認)

追加テスト数: 7件(orchestrator.test.ts 5件、zip.test.ts 2件)

### 検証

- `bun run test`: 194 tests / 20 files すべて green
- typecheck: 0 エラー
- build: 成功(service-worker.js 78.0kb ほか全 4 バンドル生成)
- `git diff --stat 7865aaa..HEAD -- src/core`: 8 ファイル・323 insertions・0 deletions
  (このセッションでの core 変更なし)

### レビューゲート

codex-review skill(native mode, `--uncommitted`)を 3 反復:
1. 初回: P2(zip entryPath の uniquify headroom 誤流用)を指摘 → 修正
2. 2回目: P1(block スコープ回復の他ブロック巻き添え)+ P2(renderTemplate throw の
   素通し)を指摘 → 修正
3. 3回目: "did not identify a concrete regression" — clean

### 懸念・残課題

- なし(codex レビュー3反復目で clean 判定)。
