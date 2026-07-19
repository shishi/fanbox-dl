# Task 4 Report: fanbox/parse.ts

## Overview
Task 4「fanbox/parse.ts(post.info パーサ)」を TDD 厳守で実行完了。

## Implementation
- `src/fanbox/parse.ts` を作成、brief のコード仕様通り実装
- `tests/parse.test.ts` を作成、brief のテストケース全て実装

## Test Coverage
- Step 1: 失敗テストを書く → tests/parse.test.ts に 13 個のテストケース実装
- Step 2: RED 確認 → src/fanbox/parse.ts が無いため失敗(期待通り)
- Step 3: 実装 → parsePost / emptyPostNotice 関数を spec 通りに実装
  - image/file/article の 3 type に対応
  - p を跨いだメディア集約(非メディアブロックはグループを切らない)
  - 名前空間別の重複スキップ(初出のみ採用)
  - idemKey 衝突の構造的排除
  - embed/url_embed/video のスキップカウント
  - restricted / body:null の正規化
- Step 4: GREEN 確認 → 全テスト PASS、型チェック PASS
  - Test Files: 5 passed (5)
  - Tests: 44 passed (44)
  - tsc: clean
- Step 5: Conventional Commit → b4ccbbb

## Grouping Rules
brief の規則を正確に実装:
- メディアブロック(image/file)以外(p等)はグループを切らない
- グループは kind が切り替わる(image群→file群)ときのみ変更
- parseIndex は投稿全体の走査順で連続カウント

## Commit Message
```
feat: fanbox post.info parser with stable-id identity

spec §6: image/file/article の 3 type を PostData に正規化。article は p を跨いで同種メディアを集約し、名前空間別の初出のみ採用で idemKey 衝突を構造的に排除する。
```

## Issues
なし。TDD の手順 1→5 は全て成功。
