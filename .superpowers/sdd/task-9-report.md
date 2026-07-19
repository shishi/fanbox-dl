# Task 9 Report: ledger 変換 A

## STATUS
COMPLETE

## Commit
5c3d557

## Test Results
87 passed (including 14 new ledger-enqueue tests), 0 failed. All tests + typecheck clean.

## Implementation Summary

Implemented core ledger transformation logic (`src/background/ledger.ts`):

- **Type definitions**: JobState, JobRecord, Ledger, EnqueueCandidate, EnqueueResult
- **emptyLedger()**: Factory for new ledger
- **applyEnqueue()**: Pure transformation handling:
  - New records: generation 0 with pending lease
  - Dedup (3-condition): done + url + canonical relPath match → skip
  - Stale-miss: url or relPath divergence → generation swap
  - pathDivergent flag: disqualifies dedup, forces swap
  - Force flag: unconditional generation swap
  - In-flight re-entry: block (unless force) or deduplicate
  - updatedDatetime warning: dedup + fresher post → warn, advance lastWarnedPostUpdatedAt only
  - Tombstone inheritance: lost generations → new records start at tombstone+1
  - Path validation: catch errors before insertion
  - Batch path dedup: reject duplicates within single enqueue call
  - refusedUrl lock: prevent automatic re-submission of server-refused URLs
  - Immutable: input ledger never mutated
- **applyPruneSweep()**: Pass-through stub (Task 10 will replace with sweep/cap logic)

## Key Decisions

- `nextGenerationPath()` helper: ensures .revN uniqueness even if canonical derivation collides
- `mint()` helper: consistent record factory preserving downgrades (lastDownloadedPostUpdatedAt, lastWarnedPostUpdatedAt)
- `commitStart()` gate: path validation + batch dedup guard before final insertion
- `TERMINAL` set: "done"|"error"|"needs_page" for state machine checks
- applyEnqueue pipes result through applyPruneSweep (spec §7c-2: single mutation, no overflow)

## Notes

- All 14 test cases pass (new records, dedup, stale-miss, generation swap, in-flight re-entry, force, updatedDatetime warnings, tombstone inheritance, path validation, batch dedup, refusedUrl lock, immutability)
- applyPruneSweep stub enables forward reference from applyEnqueue
- Task 10 will replace applyPruneSweep with real caps/sweep and add prune integration tests
