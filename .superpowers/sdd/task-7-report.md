# Task 7 Report: failure classifier + adoption 述語

## Status
COMPLETED

## Commit
`a5bf7a39db3a08bc53d4601ecbe0bfe74248f239`

## Implementation Summary

### Step 1-2: Tests Created
- `tests/failure-classifier.test.ts`: 5 test cases for `classifyDownloadError`
- `tests/adoption.test.ts`: 8 test cases for `pathMatchesBoundary` and `findAdoptable`

### Step 3: Implementation Complete
- `src/background/failure-classifier.ts`: Pure function classifying download errors into 3 categories:
  - `terminal_error`: USER_*, FILE_*, SERVER_FORBIDDEN (403), unknown/undefined
  - `retry_once`: NETWORK_*
  - `needs_page`: Other SERVER_* errors (URL expiry/edit possibility)
  
- `src/background/adoption.ts`: Lease adoption predicate functions:
  - `pathMatchesBoundary()`: Safely match absolute filenames against relative paths with separator normalization
  - `findAdoptable()`: Single-candidate adoption for crash-window orphan downloads (3-condition filter: URL match, path boundary match, startTime >= leasedAt)

### Step 4: Green + Type Check
- All 70 tests passing (10 test files)
- Zero TypeScript errors
- Tests validate spec §6 (needs_page classification) and spec §7c-1 (adoption safety rules)

## Key Design Decisions
- SERVER_FORBIDDEN (403) classified as terminal_error from first attempt (paid content scenario per spec §7a)
- Multiple adoption candidates rejected (cannot determine ownership) - worst case is single duplicate file via uniquify
- Zero candidates also rejected (falls back to normal re-submission)
- Path matching includes both complete match and suffix match with boundary protection

## Test Results
```
Test Files  10 passed (10)
      Tests  70 passed (70)
```

## Concerns
None. Implementation follows brief specification exactly, including SERVER_FORBIDDEN classification as terminal_error.
