Task 1: complete (commit d7528b5, review clean, bun は PATH=$HOME/.npm-global/bin)
Task 2: complete (gate v2 PASS status=200; canonical=content-script isolated-world fetch; commits d695e49)
Task 3: complete (commit 0965289, review clean, 33 tests)
Task 4: complete (commit b4ccbbb, review clean, 44 tests)
Task 5: complete (commit 9d0ae2c, 50 tests, controller-inspected 逐語一致)
Task 6: complete (commit df5514a, 57 tests, controller-inspected)
Task 7: complete (commit a5bf7a3, 70 tests, controller-inspected)
Task 8: complete (commit b81efeb, 73 tests, controller-inspected)
Task 9: complete (commits 5c3d557,926af00, review clean after supersededAt fix, 87 tests)
Task 10: complete (commits 94606b0,7bcaaa3, review clean after test-gap fix, 109 tests)
Task 11: complete (commit 50fc192, 114 tests, controller-inspected)
Task 12: complete (commit 87ce9ec, 125 tests, controller-inspected)
Task 13: complete (commit 8fcef32, 128 tests, controller-inspected)
Task 14: complete (commit 60630b8, 144 tests, review SPEC clean)
  Minor(最終レビュー triage): registerZipDownload の未使用 deps + finishZipDownload との zipDownloads.set 重複; handleZipDownloadChange doc-comment がブランケット契約(非 terminal delta で false)と字義不一致
Task 15: complete (153 tests, typecheck 0, build: content/background/offscreen green, options entry pending Task 16, codex review native: options 依存の既知ギャップのみ)
Task 15: complete (commit 481267a, 153 tests, SPEC ✅ Approved)
  Minor(最終 triage): 起動時 reconcileZipDownloads が write-probe より先(storage.session のみ参照で実害なし)
Task 16: complete (commit e595fd3, 153 tests, build 4-entry green, overwrite/conflictAction grep 0, controller-inspected)
Final review: codex native 反復。round1(3件)/round2(3件・fail-closed finalUrl 一様化)を fix・再レビュー clean。
  未解決(shishi 判断待ち):
  - P2 template-engine.ts:101 プレースホルダ値内 / の split(sanitize 前)→ サブフォルダ化/検証失敗。ただし core 無改造コピー制約(fantia-dl パリティ)と衝突。低exploitability(各セグメント sanitize + path-validator の traversal 拒否)
  - P3 options illegalCharReplacement に / \ を保存可(低リスク・自傷)
Final review rounds 5-6: P2 tail(blocker 無し・P1/Critical は rounds 1-4 で全解決)。
  未修正 triage:
  - P2a orchestrator.ts fire-and-forget startDownload(retry_once/reconcile): MV3 SW suspend で稀に pending 取りこぼし。起動時 reconcile/次クリックで回復可(非 core・修正可)
  - P2b template-engine.ts fmtDate が local-time getter → $date のタイムゾーン差でマシン間 relPath/dedup ズレ。**unmodified core(fantia-dl 由来)・core 無改造制約と衝突・shishi 判断**
Task 5(subagent 実装): 全16タスク完了・194 tests・build 4-entry。手動 E2E ゲート待ち。P2 tail は post-MVP backlog(P2a fire-and-forget / P2b $date TZ core)
=== 変更フェーズ開始(履歴撤去+ボタン)base f67156f ===
chg Task 1: complete (commit 86ac122, 112 tests, SPEC ✅ Approved, core 無変更・dangling 0)
chg Task 2: complete (commit 96efe83, 116 tests, 🔄 撤去・preventDefault/stopPropagation・dom-helpers 単体テスト済み, DOM 配線は手動ゲート)
chg Task 3: complete (commit 944f509, 116 tests, clearHistory/overwrite grep 0, build 4-entry, controller-inspected)
chg Task 3: complete (commit 944f509, options/README, build 4-entry, grep 0)
変更 最終レビュー: codex native 7 巡。Critical/P1 は rounds 1-4 で全解決。rounds 5-7 は redirect-map ライフサイクル + 一覧ボタン DOM 再利用の 2 領域で P2 が振動(膠着)したため automated 反復を停止(skill 準拠)。
  受容 residual(post-MVP backlog / 手動ゲートで実在確認):
  - redirect-map: terminal interrupted(SERVER_FORBIDDEN/disk-full/cancel)で mapping が browser 終了まで残存 + 失敗が silent(fire-and-forget の性質上、通常 DL の完了/失敗は追跡しない設計。finalUrl 検証は complete のみ)
  - 一覧ボタン: FANBOX が card host を非投稿へ再利用/anchor 一時差し替えした場合、古い data-fbxdl-for ボタンが残り得る(実 DOM での再利用挙動は未検証。手動ゲートで確認)
  現状 HEAD 0ce31f6: 142 tests green / typecheck 0 / build 4-entry / core 無変更

## E2E フィードバック修正ラウンド (2026-07-20)
- 一覧カードボタン「非表示」報告: 実測(getBoundingClientRect/elementFromPoint)で注入・配置・最前面とも正常と確認。真因は白背景小ボタンの視認性(サムネに埋没)。濃色半透明+白文字+影へ変更 (aefd4bb)
- 投稿ページボタンを日付ヘッダー下へ移動。placement を date/title/fallback 三値化し増分レンダリングでの昇格に対応 (codex-review P2 → clean, aaf0103)
