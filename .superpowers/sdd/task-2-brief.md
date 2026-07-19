### Task 2: Walking skeleton — background post.info fetch の hard gate(spec §13-6)

**この gate が失敗したら以降の全タスクを中断し、spec §4a の degraded モード契約に沿った spec 改訂を親セッションへエスカレーションする(spec §13-6)。**

**Files:**
- Create: `public/manifest.json`(最小版。Task 14 で完成させる)
- Create: `src/background/service-worker.ts`(gate 用最小版。Task 14 で全面書き換え)

**Interfaces:**
- Consumes: なし
- Produces: gate の合否事実のみ(コードは使い捨て)

- [ ] **Step 1: 最小 manifest を書く**

`public/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "fanbox-dl",
  "version": "0.0.1",
  "description": "pixivFANBOX downloader (walking skeleton)",
  "permissions": ["downloads", "storage", "offscreen"],
  "host_permissions": ["https://*.fanbox.cc/*"],
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "action": { "default_title": "fanbox-dl gate" },
  "icons": {}
}
```

- [ ] **Step 2: gate 用 SW を書く**

`src/background/service-worker.ts`:

```ts
// spec §13-6 walking skeleton: SW(extension context)からの post.info fetch が
// cookie 込みで 200 になるかの hard gate。アクションボタンで実行し console に出す。
// postId 12272980 は PoC(spec §4)で使った無料投稿。
chrome.action.onClicked.addListener(async () => {
  try {
    const r = await fetch("https://api.fanbox.cc/post.info?postId=12272980", {
      credentials: "include",
    });
    const j = await r.json().catch(() => null);
    console.log("[fanbox-dl gate] status =", r.status,
      "post.id =", j?.body?.post?.id, "type =", j?.body?.post?.type);
  } catch (e) {
    console.error("[fanbox-dl gate] FAILED:", e);
  }
});
```

- [ ] **Step 3: ビルド**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && sed -i "s|{ in: \"src/content/content-script.ts\".*||; s|{ in: \"src/content/page-script.ts\".*||; s|{ in: \"src/options/options.ts\".*||; s|{ in: \"src/offscreen/offscreen.ts\".*||" scripts/build.mjs && bun run build && ls dist/background'
```

Expected: `dist/background/service-worker.js` と `dist/manifest.json` が生成される。
(build.mjs の entries を SW だけに絞る sed。Task 14 でコピー原本に戻して全 entry を有効化する)

- [ ] **Step 4: 手動 gate(shishi の操作が必要 — 親セッションへ依頼して停止)**

手順(shishi 向け):
1. Chrome の `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」で `\\wsl.localhost\Ubuntu\home\shishi\dev\src\github.com\shishi\fanbox-dl\dist` を指定
2. fanbox.cc にログイン済みであることを確認
3. 拡張のアイコン(アクション)をクリック → 拡張の「Service Worker」リンクから DevTools console を開く
4. `[fanbox-dl gate] status = 200 post.id = 12272980 type = file` が出れば **gate PASS**

Expected: status 200。**403/401/失敗なら gate FAIL → 実装中断、spec 改訂へ**(Global Constraints 冒頭の中断規則)。

- [ ] **Step 5: gate 結果をコミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fanbox-dl && git add -A && git commit -m "feat: walking skeleton passing the background post.info gate (spec 13-6)" -m "SW(extension context)からの cookie 付き post.info fetch が 200 を返すことを実機 Chrome で確認。canonical 経路(spec 4a)の前提が成立したため実装を続行する。gate の実測結果: <status と postId をここに記録>"'
```

---

