# Task 5 Report: メディア URL allowlist

## Status
✓ DONE

## Commit
9d0ae2c feat: media URL allowlist guard

## Test Result
All 50 tests passing (6 url-allowlist tests + 44 existing). Typecheck clean.

## Summary
- Step 1: Test file written (6 test cases covering: valid URLs, host validation, HTTPS enforcement, path shape validation, postId checking, traversal/malformed URL rejection)
- Step 2: Red state confirmed (module not found)
- Step 3: Implementation written (validateMediaUrl function with regex-based path validation and postId matching)
- Step 4: Green + typecheck passed
- Step 5: Committed with conventional message + WHY-focused body (confused deputy prevention via pure function gate)

## Implementation Details
- Function signature: validateMediaUrl(url: string, postId: string): { ok: true } | { ok: false; error: string }
- Validates: HTTPS protocol, host (downloads.fanbox.cc), path shape (/(images|files)/post/{postId}/{filename}), and postId literal match
- Traversal vectors (../) eliminated by URL parser normalization before path regex matching
- Centralized allowlist guard placed before all network operations (spec 4a requirement)

## Notes
No concerns. TDD flow complete. Ready for Task 6.
