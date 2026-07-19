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
