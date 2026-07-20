### Task 3: options 整理 + README 更新 + 最終ビルド + 一覧オリジン gate

**Files:**
- Modify: `src/options/options.ts`(clearHistory ハンドラ削除)、`public/options/options.html`(履歴管理 UI 削除)、`README.md`(履歴・🔄 の記述を撤去、ボタン配置を反映)
- Test: 既存維持(options のロジックテスト `tests/options-validate-templates.test.ts` は維持)

**Interfaces:**
- Consumes: なし(UI/doc)
- Produces: 完成した拡張(build 4-entry)

- [ ] **Step 1: options から履歴 UI を削除**

`public/options/options.html`: 「DL 履歴の管理」ラベル・説明文・`<button id="clearHistory">`・`clearedNotice` を含む節を要素ごと削除。zip の注意書き(`zip は再開不可…`)は残す。
`src/options/options.ts`: `clearHistory` の addEventListener ブロック(`$("clearHistory")...` から通知処理まで)を削除。`chrome.runtime.sendMessage({ kind: "clearHistory" })` の参照も消える。テンプレ検証(validate-templates)・保存ガードは維持。

完了確認: `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && grep -rn "clearHistory\|DL 履歴" src/options public/options; echo exit=$?'` が **0 件**。

- [ ] **Step 2: README.md を更新**

履歴・🔄・世代付き命名・updatedDatetime 通知の記述を撤去し、次を反映(該当節を書き換え):
- ボタン: 「投稿ページはタイトル近くに ⬇。クリエイター投稿一覧では各投稿カードに ⬇ が出る」
- 挙動: 「DL 済み判定は行わない(毎回そのまま保存、同名は `foo (1).ext` で自動リネーム)」
- zip: 現状維持(best-effort・一括・失敗時は個別 DL へ)
- セキュリティ: 「メディア URL は `downloads.fanbox.cc` の正規パスのみ許可。リダイレクトで許可外へ抜けた場合はダウンロードを破棄」

- [ ] **Step 3: 全テスト + 型 + ビルド + grep ゲート**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH; cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && bun run test 2>&1 | grep -E "Test Files|Tests " && bun run typecheck 2>&1 | tail -1 && bun run build 2>&1 | tail -1 && ls dist/options && grep -c "overwrite" dist/options/options.js; true'`
Expected: 全 green・型 0・build 4-entry・`overwrite` grep 0。

- [ ] **Step 4: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "chore: drop history-clear UI, refresh README for fire-and-forget and button placement"'
```

- [ ] **Step 5: 手動 hard gate(shishi の実 Chrome。親セッションから依頼)**

`chrome://extensions` で dist を再読み込みして:
1. 投稿ページで ⬇ が**タイトル近く**に出て、DL できる(fire-and-forget・ダイアログ無し)。
2. クリエイター投稿一覧で各カードに ⬇ が出て、クリックで**カード遷移せず**その投稿を DL できる。
3. **(spec §変更 B hard gate)** 一覧ページの実行オリジンで post.info fetch が 200 になること(= 一覧カードの DL が成功する)。**もし失敗するなら**一覧ボタン機能を無効化し、投稿ページのタイトル近く配置のみ残す方針に切替(spec の見送り規定)。
4. zip(2 枚以上画像)・restricted 投稿の通知が従来どおり。

結果を `docs/superpowers/plans/2026-07-20-...` の末尾か progress ledger に記録。

---

