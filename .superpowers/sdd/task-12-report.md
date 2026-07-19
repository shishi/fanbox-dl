# Task 12 Report: fanbox/api.ts

## STATUS
✅ COMPLETE

## Commit SHA
87ce9ec

## Test Results
125 passed (11 fanbox-api tests + 114 existing)

## Implementation Summary
- **Module**: `src/fanbox/api.ts` — exported `fetchPostInfo`, `validatePostInfo`
- **fetchPostInfo**: post.info API 呼び出し、429/ネットワーク例外のみ 5 秒バックオフで 1 回リトライ。deps 注入で testability 確保(fetchFn, sleep)。credentials:include 指定。
- **validatePostInfo**: postId 文字列一致、type:string、既知形状の body 検証(image=images[], file=files[], article=blocks/imageMap/fileMap/embedMap/urlEmbedMap)。body:null は isRestricted 関係なく通す(spec §6)。未知型は OK(spec §2)。
- **Test**: 11 ケース — 200 success, 429 single retry+success, 429 double fail, network exception retry, 403 no-retry, id match, missing maps, body:null both restricted/unrestricted, type mismatch, unknown type, body shape validation。

## Concerns
なし。すべてのテストが緑、型チェック通過、spec §4a/§11 準拠。

