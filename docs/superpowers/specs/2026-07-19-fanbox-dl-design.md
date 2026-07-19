# fanbox-dl 設計書

- 日付: 2026-07-19
- ステータス: 承認済み(shishi、同日)
- 参考実装: [fantia-dl](https://github.com/shishi/fantia-dl)(同一作者・同一アーキテクチャの Fantia 版。設計書 `docs/superpowers/specs/2026-07-10-fantia-dl-design.md` を前提知識とする)

## 1. 目的

pixivFANBOX の投稿(自分がアクセス権を持つコンテンツ)を、テンプレート命名で
可能な限りダイアログ無しに自動ダウンロードする Chrome 拡張。個人アーカイブ用。

fantia-dl と機能完全パリティ: DL ボタン注入 / テンプレート命名 / DL 履歴 dedup /
再ダウンロード(履歴クリア) / zip モード / options ページ。

## 2. スコープ

### DL 対象
- `type: "image"` 投稿の `body.images[]`(原寸 `originalUrl`)
- `type: "file"` 投稿の `body.files[]`(拡張子により video / file を判別)
- `type: "article"` 投稿の `blocks[]` 中の image / file ブロック
  (実体は `imageMap` / `fileMap` から解決、**blocks の出現順を `$seq` に反映**)

### 対象外
- `type: "text"`: DL 対象ファイル無し。クリック時「対象なし」を通知
- `type: "video"`(外部埋め込み)・`embedMap` / `urlEmbedMap` の埋め込み: 対象外(通知のみ)
- 未知 type: スキップ+通知(experimental)
- `isRestricted: true`(未加入プラン): `body` が null のため取得不能。スキップ+通知
- カバー画像(`coverImageUrl`): 対象外(fantia-dl 同様)

## 3. アーキテクチャ

fantia-dl と同一の Manifest V3・5 モジュール分離。

| モジュール | 責務 | fantia-dl からの変更 |
|---|---|---|
| content script | DL ボタン注入 / postId 抽出 / MAIN-world page script 注入 → bridge 受領 | URL パターンと postId 抽出のみ変更。CSRF 抽出は**削除** |
| page script (MAIN world) | 実ページ文脈で `post.info` を fetch | CSRF ヘッダ不要になり簡素化。URL resolver は**廃止**(§7a) |
| background (service worker) | ジョブ永続化 / テンプレ展開 / 検証 / `chrome.downloads` 実行 | URL 再解決ロジック削除で簡素化 |
| core(template-engine / sanitizer / path-validator / settings / base64) | 純粋関数群 | **無改造でコピー**(テストごと流用) |
| offscreen + fflate | zip モードの blob 生成 | 無改造でコピー |

- データソースは Fanbox 公式 JSON API(`https://api.fanbox.cc/post.info?postId={id}`)。
  DOM スクレイピングはフォールバックにも使わない(API が全情報を持つことを PoC で確認済み)。

## 4. Fanbox API(Phase-0 PoC 実測・2026-07-19)

ログイン済み実 Chrome(MAIN world 相当のページ文脈)で実測。

- **認証(確定)**: cookie(FANBOXSESSID)付き `fetch(..., {credentials:"include"})` のみで 200。
  **CSRF トークン・`X-Requested-With` 等の追加ヘッダは不要**(Fantia と異なる)。
  Origin/Referer はページ文脈 fetch なら自動で正しく載る。
- **レスポンス形(確定)**: `post.info` は `{body: {post: {...}}}`。
  post 直下: `id / title / feeRequired / publishedDatetime / updatedDatetime / tags /
  isRestricted / user{userId, name, iconUrl} / creatorId / hasAdultContent / type /
  coverImageUrl / body / excerpt / nextPost / prevPost / isPinned` 等。
  一覧系(`post.listCreator`)は `body` が**直接配列**で、item に `type` は**含まれない**。
- **type: "image"(確定)**: `body = {text, images[]}`。
  image item = `{id, extension, width, height, originalUrl, thumbnailUrl}`。
  `originalUrl` は `https://downloads.fanbox.cc/images/post/{postId}/{hash}.{ext}`。
- **type: "file"(確定)**: `body = {text, files[]}`。
  file item = `{id, name, extension, size, url}`。`name` は人間可読(拡張子なし)。
  `url` は `https://downloads.fanbox.cc/files/post/{postId}/{hash}.{ext}`。
- **type: "article"(確定)**: `body = {blocks[], imageMap, fileMap, embedMap, urlEmbedMap}`。
  block は `{type: "p" | "image" | "file" | ...}`。image block は `{type:"image", imageId}` で
  `imageMap[imageId]` から image item(構造は type:"image" と同一)を解決。
  file block も同様に `fileMap[fileId]`。
- **URL の性質(確定・設計の核)**: `downloads.fanbox.cc` の URL は**クエリパラメータ無し =
  署名無し・期限無し**。無料投稿(feeRequired: 0)は**匿名(cookie 無し)curl でも 200**。
  推測不能なハッシュファイル名が実質のアクセス制御。
- **CORS(確定)**: `downloads.fanbox.cc` は CORS 全拒否(ページ文脈から fetch 不能、
  cookie 有無によらず TypeError)。`<img>` サブリソースとしては読み込み可。
- **制限投稿(確定)**: `isRestricted: true` の post.info は 200 だが `body: null`。
  title / feeRequired / user 等のメタは見える。
- **レート制限(実測)**: 短時間に約 30 リクエストで API が一時ブロックされた
  (reCAPTCHA enterprise 連動、数分で自然解除)。→ §11 スロットリング。
- **URL 形式(確定)**: クリエイターページはサブドメイン形式 `https://{creatorId}.fanbox.cc/posts/{postId}`
  が正(200)。`https://www.fanbox.cc/@{creatorId}/posts/{postId}` は 302 だが SPA 内遷移で使われる。

### 未実測(MVP マイルストーン1の hard gate、§13)
- **有料投稿のファイル URL に cookie が必須か**は未実測(PoC 時点で有料プラン未加入のため)。
  §7a のフォールバック設計で吸収する。

## 5. プレースホルダ・カタログ(fantia-dl との差分)

テンプレート文法・エンジンは fantia-dl と完全同一(`$name` / `$name{arg}` /
オプショナルグループ `[...]` / 未知プレースホルダはエラー)。**core 無改造**。
context の組み立て(background)で以下のようにマッピングする。

| placeholder | Fanbox での値 |
|---|---|
| `$creator` | `post.user.name` |
| `$creatorId` | `post.creatorId`(人間可読スラグ。Fantia の数値 ID と異なる) |
| `$postTitle` / `$postId` | `post.title` / `post.id` |
| `$date{fmt}` | `post.publishedDatetime` |
| `$today{fmt}` | 実行日(変更なし) |
| `$contentTitle` | **常に null**(Fanbox にコンテンツブロック題名が無い。`[...]` で自然に消える) |
| `$contentId` | image/file item の `id`(article は block 由来の imageId/fileId) |
| `$contentType` | photo / file / video(§6 のマッピング) |
| `$plan` | **`String(post.feeRequired)`**(例 "0", "500"。Fanbox の post.info にプラン名が無いため金額で代替) |
| `$filename` | file は `name`(人間可読)、image は URL basename(ハッシュ) |
| `$ext` | item の `extension`(URL 末尾と一致することを parse 層で検証しない。`extension` を正とする) |
| `$seq` / `$seq{n}` / `$total` | コンテンツブロック内の連番(fantia-dl と同一ルール §5) |

デフォルトテンプレート例:
`fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/[$seq{3}_]$filename.$ext`

## 6. parse 層(src/fanbox/parse.ts)

`post.info` レスポンス → core の `PostData`(型は fantia-dl の types.ts を流用)。

| Fanbox type | 変換 |
|---|---|
| image | 1 つの ContentBlock(contentType: "photo")に `images[]` を順に格納 |
| file | 1 つの ContentBlock。各 file は拡張子で判定(VIDEO_EXT 流用): video / file |
| article | blocks を出現順に走査。連続する同種(image 群 / file 群)は type 別 ContentBlock に集約し、出現順で seq を振る |
| text / video / 未知 | files 空 → DL 対象なし |

- `isRestricted: true` または `body: null` は空の PostData(contents: [])を返し、
  呼び出し側が「アクセス権なし」を通知。
- FileItem の `refetch` 情報は `{postId, contentId, index}` を維持(fantia-dl 互換)。
  ただし §7a により URL 失効が無いため、refetch は「投稿再編集で URL が変わった」場合の
  再クリック時にのみ意味を持つ。

## 7. 保存ダイアログ抑制

fantia-dl §7 と同一(`saveAs: false` + `conflictAction`、Chrome 設定 ON 時は抑制不能、
README / options に注意書き)。

## 7a. DL URL 戦略(fantia-dl §7a の置き換え・normative)

- **resolver 廃止**。`originalUrl` / `files[].url` は署名無し・期限無しの直 URL のため、
  `chrome.downloads.download({url, filename, saveAs: false, conflictAction})` に**そのまま渡す**。
  MAIN-world での URL 解決 fetch は行わない(CORS 全拒否のため不可能でもある)。
- URL 失効ケアは不要。resume(§10)でも保存済み URL をそのまま再投入できる。
- **cookie 依存性**: 無料投稿は匿名アクセス可を実測済み。有料投稿が cookie 必須でも、
  `chrome.downloads` はブラウザのネットワークスタック(profile の cookie jar)で
  ダウンロードするため成功する見込み。**MVP1 hard gate(§13)で実証**する。
- **フォールバック(予約設計・実装は gate 失敗時のみ)**: 万一 `downloads.download` が
  有料コンテンツで 403 になる場合、background から `fetch(url, {credentials:"include"})`
  (host_permissions により CORS 免除)→ offscreen で blob URL 化 → `downloads.download(blobUrl)`。
  zip モードの既存 offscreen 経路と同じ仕組みで実装できる。

## 8. 衝突・重複、9. sanitizer、10. path validator / SW ライフサイクル / ジョブ永続化 / DL 履歴

fantia-dl §8, §9, §10, §13(a) と同一。core・job-store は無改造コピー。
DL 履歴の dedup キー(`idemKey = postId:contentId:index`)も同一形式。

## 11. レート制限・リトライ(Fanbox 固有・normative)

- 通常フロー: 1 クリック = `post.info` 1 回のみ。追加の API コールは発生させない。
- PoC で連続リクエストによる一時ブロック(reCAPTCHA enterprise 連動)を実測したため:
  - API 失敗(429 / ネットワークエラー)時のリトライは**指数バックオフ(初回 5 秒)で 1 回だけ**。
    再失敗時は「時間を置いて再試行して」とユーザーへ明示エラー。
  - 将来複数 post.info を叩く機能を足す場合は必ず直列+間隔 >= 1 秒(設計原則として明記)。
- `chrome.downloads` の並列実行は Chrome 自身のキューに任せる(fantia-dl 同様)。

## 12. manifest / content script

以下は差分の要点のみの抜粋(background / options_page / action / icons は fantia-dl と同一構成):

```json
{
  "manifest_version": 3,
  "name": "fanbox-dl",
  "permissions": ["downloads", "storage", "offscreen"],
  "host_permissions": ["https://*.fanbox.cc/*"],
  "content_scripts": [{
    "matches": ["https://*.fanbox.cc/posts/*", "https://www.fanbox.cc/@*/posts/*"],
    "js": ["content/content-script.js"],
    "run_at": "document_idle"
  }],
  "web_accessible_resources": [{
    "resources": ["content/page-script.js"],
    "matches": ["https://*.fanbox.cc/*"]
  }]
}
```

- `host_permissions` の `*.fanbox.cc` は api / downloads / www / クリエイターサブドメインを包含。
- postId 抽出: pathname `/posts/{id}`(両 URL 形式共通)。creatorId はサブドメインまたは `/@{slug}`。
- Fanbox は SPA のため、`www.fanbox.cc` 内遷移で URL が変わってもページリロードが起きない。
  content script は History API 遷移を検知(`popstate` + 定期 URL チェック)してボタンを再注入する。
  (fantia-dl は静的遷移前提だったため、ここは Fanbox 固有の追加要件)

## 13. MVP マイルストーン1で実施する確認(hard gate)

1. **(hard gate)** image / file 各 1 件で「直 URL → `downloads.download` 実保存」を実証。
   `saveAs: false` でダイアログ無し保存(Chrome 設定 OFF 時)も確認。
2. **(hard gate・§7a)** 有料投稿(加入後)で cookie 依存性を実証。403 ならフォールバック実装に切替。
3. (最適化ゲート)content script(isolated world)直 fetch で post.info が 200 になるか。
   なれば page script 注入を省略し canonical を isolated world に切替(既定は MAIN world)。
4. SPA 内遷移(クリエイターページ → 投稿ページ)でボタン注入が働くか。

## 14. 設定(options)・15. テスト方針・16. 技術スタック

fantia-dl §14〜16 と同一。

- 設定: テンプレート / conflictAction / zip モード / DL 履歴クリア。`chrome.storage.sync`。
- テスト: core は流用テストがそのまま green であること。`tests/parse.test.ts` は
  PoC で実測した JSON 構造のフィクスチャ(image / file / article / restricted / text)で TDD。
- スタック: Bun + esbuild + vitest + tsc(strict)+ fflate。Nix flake + direnv。
  Renovate 設定(`.github/renovate.json`)もコピーし、初回の GitHub App 追加は shishi の手動 1 クリック。

## 17. fantia-dl からのコピー指針(実装プラン向け)

- そのままコピー(無改造が原則): `src/core/*`, `src/offscreen/*`, `src/background/job-store.ts`,
  `public/offscreen/*`, `public/options/*`, `scripts/build.mjs`, `tsconfig.json`,
  `vitest.config.ts`, `flake.nix`, `.envrc`, `.github/*`, core 系 `tests/*`
- 書き換え: `src/fanbox/parse.ts`(新規 TDD), `src/content/*`(URL・SPA 対応・CSRF 削除),
  `src/background/service-worker.ts`(resolver 削除・$plan マッピング), `public/manifest.json`,
  `README.md`, `package.json`(name のみ)
- fantia-dl 側リポには一切手を入れない。
