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
| content script | DL ボタン注入 / postId 抽出 / **isolated world から `post.info` fetch(§4a canonical)** / 受領 json を SW へ送信 | CSRF 抽出と page script 注入機構は削除。post.info fetch は isolated world が担う(§4a: SW fetch は Origin 起因で 400) |
| background (service worker) | **受領 json の schema+allowlist 検証(§4a)** / ジョブ永続化 / テンプレ展開 / 検証 / **DL URL の allowlist 検証** / zip 用ソース fetch(§7b)/ `chrome.downloads` 実行 | URL 再解決ロジック削除。post.info fetch は content script へ移動。受領データの検証と allowlist が加わる |
| core(template-engine / sanitizer / path-validator / settings / base64) | 純粋関数群 | **無改造でコピー**(テストごと流用) |
| offscreen + fflate | zip モードの blob 生成・zip 用バイナリ取得 | zip 生成は無改造。**バイナリ取得経路は再設計**(§7b) |

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

### 追加実測(2026-07-19・gate §13-6)
- **`api.fanbox.cc` は Origin ゲートあり**: 拡張 SW からの fetch(Origin `chrome-extension://…`)は
  cookie 付きでも **400**。ページオリジン(`https://www.fanbox.cc`)の fetch は **200**。
  → canonical を content script isolated world fetch に変更(§4a)。

### 未実測(MVP マイルストーン1の hard gate、§13)
- **有料投稿のファイル URL に cookie が必須か**は未実測(PoC 時点で有料プラン未加入のため)。
  §7a のフォールバック方針で吸収する。
- **content script(isolated world)からの `post.info` fetch が cookie 込みで 200 になること**は
  **2026-07-19 に gate v2(walking skeleton)で実証済み**(`origin=https://www.fanbox.cc
  status=200 post.id=12272980 type=file`)。canonical 経路として確定。

## 4a. post.info 取得経路と信頼境界(normative)

fantia-dl は CSRF トークンの都合で MAIN-world page script が canonical だったが、
Fanbox は cookie のみで認証できる。当初は SW fetch を canonical にしたが、
**実測(2026-07-19、gate §13-6)で `api.fanbox.cc` が非ページ Origin のリクエストを
400 で拒否することが判明した**(拡張 SW の Origin は `chrome-extension://…`。cookie は
送れており 401/403 の認証エラーではない)。そこで**信頼境界を保てる範囲で最も安全な
成立経路 = content script の isolated world fetch を canonical にする**。

- **canonical**: content script が **isolated world** で
  `fetch("https://api.fanbox.cc/post.info?postId=...", {credentials: "include"})` を実行する。
  isolated world の fetch は**ページオリジン `https://www.fanbox.cc` を Origin として送る**ため
  400 を回避できる(実測: ページ文脈 fetch = 200)。得た json は `chrome.runtime.sendMessage`
  で background へ渡す。
  - **信頼境界(normative)**: isolated world は拡張が注入した隔離実行環境で、ページの
    MAIN world JS(XSS・monkeypatch 含む)から DOM も変数も fetch 呼び出しもレスポンスも
    参照・改変できない。したがって旧 MAIN-world bridge(ページ文脈実行 = ページ JS が
    `fetch` を差し替え可能)より信頼境界が**強い**。残る信頼リスクは fanbox サーバ自体が
    悪意あるデータを返すことのみで、これは SW canonical でも同一であり、下記の
    schema+allowlist 検証(SW 側)が最終防壁となる。
  - **ページオリジンの正規化(実測 2026-07-19)**: クリエイターサブドメイン
    `https://{creator}.fanbox.cc/posts/{id}` を開いても、ブラウザ内では
    `https://www.fanbox.cc/@{creator}/posts/{id}` に正規化され、投稿ページの実行オリジンは
    常に `https://www.fanbox.cc` になる(isolated world fetch の Origin もこれ)。したがって
    どの入口 URL でも canonical fetch は成立する見込みだが、**cold direct-load(ブックマーク等で
    サブドメイン URL を直接開く)でも 200 になることを §13-6 gate で必ず確認**する
    (SPA 内遷移だけで通し、cold load を落とす取りこぼしを防ぐ)。
  - `downloads.fanbox.cc`(zip 用ソース §7b / DL URL)は CORS 全拒否で content script から
    fetch できないため、**そちらは引き続き SW fetch**(CDN のため Origin ゲート無し。
    host_permissions で CORS 免除)。post.info(api.fanbox.cc)だけが content script 経路。
- **フェイルクローズ(normative)**: content script fetch も失敗する環境(ログアウト等)では
  「post.info を取得できない」ことを明示エラーにして**停止する**(部分的な状態で走らせない)。
- **受領 json の normative な防御(SW 側で必ず実施)**: content script が渡す json は
  isolated world 由来でページ JS 非介入とはいえ、SW は生データを信用せず次を通す:
  1. レスポンス schema 検証: `body.post.id` が要求 postId と一致すること、type / body 構造が
     既知の形であること。不一致は enqueue せず明示エラー。
  2. **メディア URL の allowlist(全ネットワーク使用前・normative)**: parse 層が受け取った
     すべてのメディア URL は、**いかなるネットワーク使用よりも前に**(通常 DL の
     `downloads.download`、zip 用ソース fetch(§7b)、`needs_page` 回復の再解決を含む全経路)
     次の条件で検証する:
     - host が `downloads.fanbox.cc` であること(将来ホストが増えたら allowlist を明示更新)
     - path が `/images/post/{postId}/...` または `/files/post/{postId}/...` の形で、
       `{postId}` が当該ジョブの postId と一致すること
     違反はジョブを enqueue せず(既存ジョブなら error にして)明示通知する。
     confused deputy(拡張権限・拡張 cookie 文脈での任意 URL fetch/DL)を防ぐ。
     検証は純粋関数として実装し単体テストを必須とする。
  3. **リダイレクト対策(normative)**: allowlist は初期 URL 文字列を検証するが、fetch/DL が
     リダイレクトを追うと allowlist 外へ抜け得る(confused deputy の再発)。
     - **zip 用ソース SW fetch(§7b)**: `fetch(url, {credentials:"include", redirect:"error"})` とし、
       リダイレクトが発生したら fail closed(そのブロックは zip 不成立 → 個別 DL フォールバック)。
     - **`chrome.downloads.download`(緩和 + residual risk 明記・normative)**: API は
       リダイレクト抑止を指定できない。完全予防には全ファイルへ preflight fetch が要り、
       §11 のレート制限方針・§7a の「resolver 廃止/直 URL を渡す」原則と衝突するため、
       本 spec は**予防ではなく緩和**を採る: 完了時(§7c-2 の `onChanged` terminal)に取得する
       `DownloadItem.finalUrl` を allowlist(§4a-2)で再検証し、違反していたらそのジョブを
       `error`(「ダウンロードが許可外 URL にリダイレクトされました」)にする
       (実ファイルは残るが帳簿上 done にせず明示エラー・dedup 対象にしない)。この finalUrl
       再検証も単体テストの対象。
       **residual risk(明示)**: これは検出であって予防ではない — 悪意ある/侵害された
       `downloads.fanbox.cc`(pixiv CDN)が allowlist 外へリダイレクトした場合、
       検出前に 1 ファイル分のバイトがユーザーのアーカイブフォルダに書かれ得る。
       脅威の前提が CDN 自体の侵害であり、個人アーカイブツールの文脈ではこのリスクを
       受容する(README にも DL 元は Fanbox CDN 前提と明記)。将来レート制限が緩い経路を
       確立できたら preflight 予防への格上げを検討する。

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
| `$contentId` | **ContentBlock の post 内通し番号("1", "2", …)**。fantia-dl の block-id 相当で、通常 DL・zip の両テンプレ文脈で同じ値(テンプレ用の値であり、識別子ではない。identity は §6 の `stableContentId` = `image:{id}` / `file:{id}` が担い、テンプレには出さない) |
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
| article | blocks を出現順に走査。連続する同種(image 群 / file 群)は type 別 ContentBlock に集約し、出現順で seq を振る。**「連続」の判定はメディアブロック(image/file)だけを見て行い、p 等の非メディアブロックはグループを切らない**(画像と本文が交互に並ぶ典型 article でギャラリーが単発に分解され、zip(§7b)が成立しなくなるため)。**同一 post 内で同じ imageId / fileId が複数回出現した場合は初出のみ採用**(後続出現はスキップ。同一実体の重複 DL と `idemKey = postId:stableContentId` の衝突による job 上書き消失を防ぐ)。`$seq` / `$total` はスキップ後のユニークなファイル列に対して振る |
| text / video / 未知 | files 空 → DL 対象なし |

- `isRestricted: true` または `body: null` は空の PostData(contents: [])を返し、
  呼び出し側が「アクセス権なし」を通知。
- **識別子は Fanbox の安定 ID を主キーにする**(fantia-dl の ordinal 依存からの変更):
  各 FileItem は Fanbox の item id(image/file item の `id`。article では imageId/fileId と同値)
  を種別付きで `stableContentId = "image:{id}"` / `"file:{id}"` の形式に正規化して保持し、
  `idemKey = postId:stableContentId`(= `postId:image:{id}` 等)とする。
  **構造的分離(normative)**: 識別子(`stableContentId`)とテンプレ用ブロック番号
  (`blockOrdinal`、§5 の `$contentId` の値)は**別フィールドとして型で分離**し、
  fantia-dl の単一 `contentId` 文字列を両用途に使い回さない(どちらも string のため、
  取り違えても型エラーにならず「もっともらしく壊れる」移植事故を防ぐ)。
  `FileItem` / `refetch` / ledger レコードは `stableContentId` を持ち、
  `ContentBlock` は `blockOrdinal` を持つ。
  **render 境界の adapter(normative)**: core の template-engine は無改造のため、
  その入力(`RenderContext`)の `contentId` フィールド名は変えられない。そこで
  「`blockOrdinal` → `RenderContext.contentId`」への写像を**レンダリング直前の単一の
  adapter 関数に閉じ込める**(通常 DL・zip の両経路がこの同一 adapter を通る。
  単体テスト必須)。`contentId` という名前が現れるのはこの adapter の出力
  (render 呼び出しの内側)だけであり、enqueue メッセージ・ledger・refetch など
  identity を運ぶ構造には決して現れない。`src/core/types.ts` の改変
  (`stableContentId` / `blockOrdinal` の導入)は §17 の書き換え対象に含まれる。
  imageMap と fileMap は**別名前空間**であり、Fanbox が両者間の ID 一意性を保証する根拠は
  無いため、種別判別子で衝突を構造的に排除する(§6 の重複スキップ規則は名前空間ごとに適用)。`index`(パース順)は**ファイル名の $seq 用と整合性チェック専用**で、
  識別には使わない。`refetch` は `{postId, stableContentId, index}` を持つ(§17 の types.ts 改変に含まれる)。
- 署名失効こそ無いが、**投稿の再編集でファイル URL(ハッシュ名)が差し替わる**ことは
  あり得るため、fantia-dl の回復機構(`needs_page` 状態 + refetch)を**削らずそのまま残す**。
  ただし `needs_page` へ落とす前に **failure classifier(normative)** を通す:
  `chrome.downloads` の `onChanged` で `delta.error.current` を消費して分類し、
  - `USER_*`(ユーザーキャンセル)/ `FILE_*`(ディスク満杯・パス不正等のローカル要因)は
    **terminal `error`**(投稿ページを開いても直らないため needs_page にしない)
  - `NETWORK_*`(一時的な回線断)は保存 URL の**有界リトライ(1 回)** → 再失敗で terminal `error`
  - `SERVER_FORBIDDEN`(403)は **terminal `error`(明示メッセージ「サーバがダウンロードを
    拒否しました(未加入の有料コンテンツの可能性)」)**。§7a の「有料 403 は明示エラー」を
    初回失敗の時点で満たすため needs_page にしない(編集由来で 403 が返る稀なケースでも、
    次クリックの enqueue は URL が変わっていれば error レコードを再投入するため回復性は保たれる)
  - その他の `SERVER_*`(404 等 = URL 失効・編集の可能性)のみ `needs_page` に遷移
  分類器は純粋関数として実装し単体テストを必須とする。`needs_page` のジョブは、
  次にその投稿ページでボタンを押したとき post.info を再取得して回復する。回復時のファイル特定は
  **`stableContentId` の一致のみで行い**、再取得後の投稿に該当 ID が無ければ
  「投稿が編集され該当ファイルは存在しない」と**明示エラーにする**(ordinal で別ファイルに
  誤バインドする静かな失敗を禁止)。該当 ID はあるが **URL が失敗時と同一**の場合も
  再投入しない(編集由来の失効ではなく、再投入しても同じサーバ失敗を繰り返すだけの
  クリックごと無限ループになるため)。この場合は「同じ URL のままサーバ側の失敗が
  続いています。時間を置いて再試行してください」という**中立の明示 terminal error** にする
  (有料 403 の明示エラーは §6 の classifier(SERVER_FORBIDDEN → terminal)が担う)。resume(SW 再起動時)は保存 URL の再投入を第一手とし、
  失敗したら同じ `needs_page` 経路に合流する。

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
- **フォールバック(方針のみ・スコープ外)**: 万一 `downloads.download` が有料コンテンツで
  403 になる場合は、background fetch → offscreen blob 化の経路に切り替える方針とするが、
  fantia-dl の blob 経路は job-store / reconcile の外にある one-shot 実装であり、
  そのまま流用すると dedup・resume・`needs_page` 回復が丸ごと失われる。したがって
  **このフォールバックは本 spec のスコープ外**とし、gate(§13-2)が実際に失敗した場合に
  「永続化される source URL / refetch メタデータ・reconcile 規則を含む一級市民の DL モード」
  として別途 spec 化してから実装する。それまで有料投稿 DL が 403 になる環境では
  明示エラーを出すに留める(静かな失敗にしない)。

## 7b. zip モード(対象条件とバイナリ取得・normative)

**zip の対象条件(fantia-dl の「ギャラリーのみ」規則を踏襲・normative)**:
`zipGalleries` 設定(既定 ON)のとき、**contentType が "photo" かつファイル数 2 以上**の
ContentBlock のみをブロック単位で 1 つの zip にまとめる(fantia-dl 実装の
`files.length >= 2` ゲートと同一。1 枚だけの photo ブロックを one-shot zip 経路に
落として耐久性を失う利益は無いため、**単発 photo は常に個別 DL**)。具体的には:
- `type: "image"` 投稿の `images[]`(2 枚以上のギャラリー相当)→ 1 zip
- `type: "article"` 内の image ブロック群(§6 で集約された photo ContentBlock、2 枚以上)→
  **グループごとに 1 zip**(1 記事に複数グループがあれば複数 zip)
- file / video(添付ファイル)は zip 対象外で**常に個別 DL**(fantia-dl と同一)
**zip 不成立時のフォールバック(normative・この段落が唯一の規定)**: 事前サイズ/件数
チェックの拒否、実行時バイトバジェット超過による中止、SW fetch 失敗など、
**zip が成立しなかった photo ブロックは、自動的に通常の個別 DL 経路(§7a、ジョブ永続化
あり)に enqueue し直し**、「この投稿(の一部)は zip にできないため個別ダウンロードに
切り替えました」という**非致命の通知**を出す。ファイルが黙って欠落する終端状態を
作らない(後述 §7b 内の「明示エラー」記述はこのフォールバック+通知を指す)。

**zip 名の導出**: fantia-dl の既定 `$contentTitle.zip` は Fanbox では成立しない
($contentTitle は常に null、§5)。`$contentId`(ブロック通し番号、§5)を使い、
zipPathTemplate の既定を
`fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/images_$contentId.zip` とする
(複数グループでも決定的に命名が分かれる)。zip 内エントリの既定は fantia-dl と同一
(`[$seq{3}_]$filename.$ext`)。テンプレエンジン(core)のプレースホルダ集合は
無改造(`$contentId` の値がブロック通し番号になるのは context 組み立て側の責務)。

fantia-dl の zip 経路は MAIN-world page script が対象 URL を fetch してバイト列を得るが、
Fanbox では `downloads.fanbox.cc` が CORS 全拒否のため**この経路は成立しない**(§4 実測)。

- **canonical 経路**: background(service worker)が `fetch(url, {credentials: "include", redirect: "error"})`(§4a-3 リダイレクト対策)で
  バイト列を取得する。`host_permissions: https://*.fanbox.cc/*` により拡張コンテキストの
  fetch は CORS 免除される(MV3 の仕様)。取得したバイト列を offscreen に渡して
  fflate で zip 化 → blob URL → `downloads.download`(zip 生成部は fantia-dl と同一)。
- **hard gate(§13)**: 無料投稿で zip E2E(SW fetch → zip → 実保存)を MVP1 で実証する。
  有料投稿は加入後に同じ gate を再実行(§13-2 と同時)。
- **gate 失敗時のフォールバック**: SW fetch が cookie 事情等で 403 になる場合でも、
  通常 DL(§7a)には影響しない。zip が成立しない場合の挙動は冒頭のフォールバック規定
  (個別 DL への自動切替+非致命通知)に従う(静かな空 zip・黙った欠落を作らない)。
- **durability の位置づけ(normative)**: zip モードは fantia-dl と同様
  **best-effort の one-shot 機能であり、durability 保証の対象外**とする。
  job-store による dedup / resume / `needs_page` 回復は zip には適用されない
  (fantia-dl README「zip モードの DL は 1 回きり扱いで履歴に残りません」と同一の契約)。
  そのうえで最悪ケースを抑えるため:
  - **サイズ制限(二段構え)**: 上限は単一の名前付き定数 **`ZIP_SOURCE_BUDGET_BYTES`
    (既定 100MB)** とし、事前チェックと実行時バジェットの両方が**同じ値**を参照する。
    (a) 事前チェック — サイズ既知の item の合計が `ZIP_SOURCE_BUDGET_BYTES` を超える、
    または件数上限(既定 100 件)を超えるブロックは zip を開始しない(冒頭の
    フォールバック規定に従い個別 DL へ)。
    (b) **実行時バイトバジェット(normative)** — image item はサイズ不明のため、
    zip 用ソース fetch 中に累積受信バイト数を計上し、`ZIP_SOURCE_BUDGET_BYTES` を
    超えた時点で fetch を中止・部分 zip を作らず明示エラーにする。
    **上限値と限界の明示**: コピー元の zip 経路は全ソースのメモリ保持 → `zipSync` の
    全量バッファ → base64 チャンク → offscreen での Blob 再組立と、ピーク時に
    ソースバイト数の数倍のライブメモリを要する。`ZIP_SOURCE_BUDGET_BYTES` の既定 100MB は
    この増幅を織り込んで保守的に選んだ値である。
    この上限は**クラッシュを保証付きで防ぐものではなく、リスクを実用範囲に抑える緩和策**
    である(ピークメモリはソースの数倍になる前提で保守的に選んだ値)。
    MVP1 で実測(§13-5 と同時に上限付近の投稿でピークメモリを確認)し、必要なら調整する。
    ストリーミング zip(fflate の streaming API)への置き換えは、実測で問題が出た場合の
    改善候補として記録に留める(現段階では fantia-dl とのコード共有を優先)。
  - 途中失敗は部分 zip を保存しない。明示エラー(冒頭のフォールバック+通知)の**配達経路は
    失敗の検出時点で決まる**: クリック処理中に検出できる失敗(fetch 失敗・バジェット超過・
    offscreen 失敗等)はその場で個別 DL フォールバック+「zip は最初からやり直し。確実性が
    要るなら通常 DL を」を含む通知。**blob の `downloads.download` を発行した後**の失敗
    (応答返却後で click 通知は物理的に不可能)は、Chrome のダウンロード UI 上の失敗表示+
    console への同文言ログに拠り、blob URL は revoke してリークさせない(one-shot 契約の
    境界として README に明記)。
  - options / README に「zip は再開不可の一括処理。大きい投稿は通常 DL 推奨」と明記する。
  失敗の回復可能性が要るユースケースは通常 DL(§7a、ジョブ永続化あり)が正であり、
  zip はあくまで携帯性のための補助機能という役割分担を仕様として固定する。

## 7c. 継承 durability モデルの補強(fantia-dl からの変更・normative)

fantia-dl の worker / job-store を土台にするが、以下 3 点は Fanbox 版で仕様として補強する
(job-store は「無改造コピー」ではなく**小改修**になる。§17 に反映)。

1. **download() と永続化の非アトミック性**: `chrome.downloads.download()` の呼び出しと
   `downloadId` の永続化の間に SW が suspend すると、resume が同じジョブを再投入し得る。
   `conflictAction: uniquify` により**上書き破壊は構造的に起きない**(最悪は「 (1)」付きの
   重複ファイル)ことを仕様として明記した上で、重複自体も減らすため **lease 方式**を採る:
   `download()` を呼ぶ**前に** `{idemKey, relPath, url, leasedAt}` の lease を永続化し、
   成功後に `downloadId` で上書きする。resume の reconcile は、lease が残っている
   (= crash window 内の)ジョブに限り `chrome.downloads.search({url})` を行い、
   **(a) URL 完全一致 (b) `chrome.downloads` item の `filename`(絶対パス)を
   セパレータ正規化(`\\` → `/`)した上で、`normalizedAbs === relPath` または
   `normalizedAbs.endsWith("/" + relPath)` の**パス境界安全な一致**
   (裸の suffix 一致は `foobar/baz.jpg` が `bar/baz.jpg` に誤マッチするため禁止)
   (c) startTime が leasedAt 以降**の 3 条件を満たす項目だけを adopt する
   (`filename` は絶対パスで返る — fantia-dl spec §10 で実証済み。この述語は
   純粋関数として実装し、境界誤マッチのケースを含む単体テスト必須)。
   条件を満たす項目が**複数残った場合は adopt を拒否**して通常の再投入に落とす
   (どれが自ジョブの成果か決定できないため)。条件を満たす項目が無い場合も再投入。
   このとき最悪ケースは uniquify による重複ファイル 1 個であり(§7c-1 冒頭)、
   **adopt の失敗は常に安全側(重複)に倒れ、成果の欠落や上書きにはならない**。
   **URL 一致だけで過去の履歴項目を成果と見なすことは禁止**
   (Fanbox URL は安定・公開のため、古い手動 DL や旧テンプレ時代の完了項目と衝突し得る)。
2. **有界の単一 ledger と原子的な状態遷移**: `chrome.storage.local` は 10MB。
   ジョブ帳簿は fantia-dl と同じく**単一キー(`jobs`)の ledger** とし、各レコードが
   state(pending / requested / done / error / needs_page)、
   **`generation: number`(必須永続フィールド。初世代は 0、世代交代のたびに +1。
   canonical パスの `.rev{N}` は常に `.rev{generation}` としてのみ導出する — 再計算・
   リセットによる旧パス再利用の禁止。suspend / 再起動 / prune / divergent 回復をまたいで
   単調増加が保たれることをテストで検証)**、世代情報(`supersededUrl` / `supersededAt`)、
   および**現行世代の `leaseToken`**(非 terminal レコードに必須の一意トークン。
   requeue・世代交代のたびに再発行)を持つ。
   **原子性(normative)**: あらゆる状態遷移(enqueue・stale-history miss の世代交代・
   完了・prune・クリア)は「ledger を読み、メモリ上で変換し、**1 回の
   `chrome.storage.local.set({jobs})` で書く**」単一ステップで行う。単一キーの単一 set は
   全体が反映されるか全く反映されないかのどちらかであり、**クロスキー移送という
   中間状態がそもそも存在しない**(= クラッシュ時の回収規則・併存不変条件が不要)。
   **書き込みの直列化(normative)**: ledger への全ミューテーションは SW 内の
   **single-writer キュー(promise チェーン)**を必ず通す。enqueue / 起動時 reconcile /
   `downloads.onChanged` / force / prune / clear は await を跨いで interleave し得るため、
   read-modify-write の並行実行(last-write-wins による静かな破壊)を構造的に禁止する。
   **キューの範囲(normative・デッドロック防止)**: キュー項目は「ledger を読む →
   純粋関数で変換 → 1 回 set」という**短命な storage 操作のみ**を含む。
   `chrome.downloads.download()` / `search()` / `cancel()` の呼び出し、terminal 遷移や
   `download()` 解決の**待機は、必ずキューの外で行う**(§7c-3 の「lease 解決待ち」を
   キュー内で行うと、待ちを解消する側の `onChanged` / promise 解決ハンドラの ledger 更新が
   同じキューの後ろに詰まり、デッドロック/見かけ上のタイムアウトになるため)。
   待機とイベントの対応付けには各 lease に発行する一意の **leaseToken** を用いる:
   `download()` 解決・`onChanged` terminal 到達はそれぞれ「leaseToken X を解決した」という
   短いキュー項目として ledger に反映し、force / clear の待機側はキュー外で
   その解決を(有界時間)観測してから、削除という次の短いキュー項目を積む。
   **CAS ガード(normative)**: あらゆる解決イベント(`download()` の fulfilled / rejected、
   `onChanged`、cancel 完了、adoption 結果)による ledger ミューテーションは、変換関数内で
   「対象レコードの現行 `leaseToken` がイベントの持つトークンと一致する」ことを確認し
   (compare-and-swap)、不一致なら**旧世代の stale イベントとして無視**する。
   これが無いと「lease A を cancel/timeout → 同一 idemKey に lease B を発行 → A の遅延解決が
   到着して B のレコードを誤って done/error/downloadId 上書き」という静かな帳簿破壊が起きる。
   必須テスト: lease A が force/requeue で lease B に置き換わった後に A の遅延解決が届く
   ケースで、B のレコードが不変であること。
   直列化キューも ledger 変換(純粋関数)もユニットとして切り出しテストする
   (「force が lease 解決待ちの間も onChanged の更新が通る」ことのテストを含む)。
   **量的上限(normative)**: ledger サイズは「terminal レコード上限 5,000 件(超過分は
   古い順に prune)+ 1 年 sweep」で**有界**とする。prune は新レコード挿入と同一
   ミューテーション内で行い、上限超過状態の ledger を書かない。有界であるため
   「履歴肥大により書き込みが失敗する」経路は設計上排除される。
   **generation の prune 耐性(normative)**: `generation > 0` のレコードを prune / sweep /
   履歴クリアで削除する際は、ledger 内の別領域(`generations: {idemKey: maxGeneration}`)に
   カウンタを残す(tombstone)。同一 idemKey の次回 enqueue は
   `max(tombstone, 0) + 1` ではなく **tombstone を初期 generation として引き継ぐ**ことで
   `.rev` パスの再利用を防ぐ。tombstone は「編集で世代交代が起きた idemKey」にしか
   作られないため通常は極小だが、上限 10,000 件(超過分は古い順に削除)で有界化する。
   tombstone が失われた場合(上限超過)の最悪ケースは canonical パス再利用 → uniquify
   発動 → `pathDivergent` → divergent 回復(世代インクリメントで未使用パスに収束)であり、
   **うるさいが静かな破壊にはならない**(このフォールバック連鎖もテスト対象)。
   **書き込み失敗時の契約**: それでも `set()` が失敗した場合(他要因の quota 逼迫等)は
   フェイルクローズし、新規 enqueue / resume / force を「ストレージ書き込みに失敗しました。
   履歴をクリアするまで DL 機能を停止します」という明示エラーで拒否する
   (live download と帳簿がずれた状態で走り続けることの禁止)。この失敗経路のテスト
   (set をモックして失敗させる)を必須とする。
   **通常 enqueue の再入規則(normative)**: 同一 `idemKey` に非 terminal レコード
   (pending / requested)が既に存在し、その `{url, relPath}` が今回のレンダリング結果と
   一致する場合、enqueue は「既にキュー済み/実行中」として**新しい lease も `download()` も
   発行せずに返る**(ダブルクリック・同一投稿を開いた複数タブからの同時 enqueue が
   典型)。live レコードを追い越して置換できるのは **force の世代交代スワップだけ**。
   `{url, relPath}` が不一致の非 terminal レコードに遭遇した場合(編集直後の再クリック等)も
   自動では置換せず、「進行中のダウンロードがあります。作り直すには再DLボタンを」と
   明示通知する。必須レーステスト: ダブルクリック / 2 タブ同時 enqueue / lease 解決が
   未完のうちに次の enqueue が到着、の 3 ケースで `download()` が二重発行されないこと。
   **stale-history miss の世代交代**: URL 不一致による再ダウンロード(§8)は、同一
   ミューテーション内で旧 done レコードを新 pending レコードに置換し、旧 `url` / `doneAt` を
   `supersededUrl` / `supersededAt` に引き継ぐ。遷移は 1 回の set なので、再DL 中に SW が
   再起動しても ledger には「pending(世代交代済み)」が単独で存在するだけであり、
   誤回収の余地は無い(このシナリオも必須テスト)。
   **canonical パス導出関数(normative)**: 「テンプレートのレンダリング結果(base パス)+
   generation → canonical `relPath`」の昇格規則を**単一の純粋関数
   `canonicalRelPath(basePath, generation)`** として固定する:
   `generation === 0` なら basePath をそのまま、`generation > 0` なら拡張子の直前に
   `.rev{generation}` を注入する(sanitizer / path validator を通す)。
   この関数を **enqueue・dedup 比較・force・stale-history miss・divergent 回復・
   resume adoption のすべての経路で共通利用**する。dedup 比較(§8)は「保存済みレコードの
   `relPath` == canonicalRelPath(現在のレンダリング結果, レコードの `generation`)」で行う
   ため、一度 `.revN` を発行したファイルもテンプレートが素の basePath を出し続ける限り
   dedup が成立し続ける(毎回 miss して再DLし続けるループは構造的に起きない)。
   単体テスト必須(gen 0 / gen>0 / dedup 回復の各ケース)。
   **同一パス世代交代の canonical パス規則(normative・世代交代全般に適用: stale-history
   miss / force / divergent 起点を問わない)**: 世代交代後のレンダリング結果
   (canonicalRelPath 適用後)が旧レコードの `relPath` と同一になる場合
   (「ファイルだけ差し替えられた」典型ケース)、
   そのまま `downloads.download` に渡すと Chrome の `uniquify` が新バイトを
   `foo (1).ext` に逃がし、**帳簿上の relPath は古いファイルを指したまま「最新」と
   証明してしまう**。これを禁止し、拡張側が**決定的なバージョン付きパス**
   (拡張子の直前に `.rev{N}`。N は世代番号。sanitizer / path validator を通す)を生成して
   新世代の canonical `relPath` として永続化する(パスの決定権を uniquify に渡さない)。
   adoption 述語・dedup の relPath 照合も、この canonical `relPath` を基準に働く。
   バージョン付き命名は README に明記する(旧ファイルは自動削除しない)。
   **実保存パスの記録と乖離の扱い(normative)**: ジョブ完了時(`onChanged` terminal)に
   `chrome.downloads.search({id})` で Chrome が実際に保存した絶対パス(`filename`)を取得し、
   レコードの `actualFilename` として永続化する。`actualFilename` が要求 `relPath` と
   一致しない(境界安全比較。uniquify 発動等)場合はレコードに `pathDivergent` を立てる。
   **`pathDivergent` な done レコードは dedup の権威にならない**(dedup miss として扱う):
   帳簿が「`relPath` が最新」と証明できるのは実際にそのパスへ保存できた場合だけである。
   divergent レコード起点の次の enqueue は世代交代スワップとして扱い、
   **必ず拡張所有の `.rev{N}` canonical パスを新規に発行**して衝突源から離脱する
   (再び uniquify に逃げられて divergent を繰り返すループの禁止)。
   このケース(divergent → 再クリック → .revN で成功し dedup が回復)も必須テスト。
3. **再DL・履歴クリアと進行中ジョブの整合**: `force`(再DL)は対象投稿の
   非 terminal ジョブの `downloadId` を `chrome.downloads.cancel()` し、terminal 遷移を
   確認(有界待機、タイムアウト時は明示エラー)した後、**レコードを削除するのではなく
   stale-history miss と同一の単一ミューテーション世代交代スワップ(§7c-2)で
   新 pending 世代に置換する**(世代番号をインクリメントし、旧 `url` / `doneAt` /
   `relPath` を `superseded*` に引き継ぐ)。「削除してから盲目的に再作成」は、次の enqueue が
   世代文脈を失って旧 `relPath` を再利用し、uniquify 逃げ(§7c-2)を再発させるため禁止。
   **lease 未解決レコードの扱い(normative)**: lease は書かれたが `downloadId` が
   まだ無いレコード(= `download()` 呼び出しが解決していない窓)は、force / クリアの
   対象として**そのまま削除してはならない**。ブラウザ側で DL がこの後開始・完了し得るため、
   削除すると帳簿に説明のつかない孤児ファイル/重複を残す。処理規則:
   (a) SW が生きていて `download()` の promise が追跡できる場合はその解決を待つ
   (解決後は通常の cancel → terminal 確認 → 削除の経路)。
   (b) promise を失った場合(SW 再起動直後等)は、resume と同一の adoption 述語
   (URL + 境界安全パス一致 + startTime >= leasedAt)で `chrome.downloads.search` を行い、
   ヒットした項目を cancel(または terminal なら採用)してからレコードを削除する。
   いずれの場合も **lease が未解決のままの削除・requeue は禁止**。
   このシナリオ(lease 窓中の force / クリア)も必須テストに含める。
   options の「履歴全クリア」は ledger 内の terminal レコード(done / error /
   needs_page)のみ削除し、進行中(pending / requested)のレコードは terminal になるまで
   残す(進行中 DL の帳簿を消して孤児化させない)。この選択的クリアも単一ミューテーション。

## 8. 衝突・重複、9. sanitizer、10. path validator / SW ライフサイクル / ジョブ永続化 / DL 履歴

**fantia-dl §8 からの変更(normative)**: `conflictAction` は **`uniquify` のみ**をサポートし、
fantia-dl にあった `overwrite` オプションは fanbox-dl では**提供しない**。
本 spec の耐久性モデル(§7c)は「衝突時の最悪ケースは重複ファイルであり、既存バイトの
無言置換は構造的に起きない」という uniquify の性質に依存しており、`overwrite` を許すと
crash window・adoption miss・tombstone 喪失時の再投入が**既存ファイルの無言破壊**に化ける。
バージョン管理は拡張所有の `.rev{generation}` 命名(§7c-2)が担う。
その他は fantia-dl §8, §9, §10, §13(a) と同一。core は無改造コピー。job-store は §7c の 3 点
(URL 採用 reconcile・件数上限 prune・set 失敗の明示通知・クリア時の進行中保護)を加えた小改修。
DL 履歴の dedup キーは `idemKey = postId:stableContentId`(安定 ID ベース、§6)とし、
  **dedup 判定は「idemKey の done レコードが存在し、かつレコードに保存された `url` と
  `relPath` の両方が、現在の post.info とテンプレートから導いた値に一致する」場合のみ
  成立**とする(JobRecord は元々 `url` と `relPath` を保持している)。
  `relPath` 条件は、URL が同じでもテンプレート入力(投稿タイトル・article の並び順に
  由来する `$seq` 等)が変わった場合に「古いパスに置き去りのまま永久スキップ」になる
  アーカイブ乖離を防ぐ: レンダリング結果が変われば新世代として再ダウンロードする
  (旧ファイルは自動削除しない — 再DL ボタンと同じ契約)。テンプレート変更そのものによる
  一括再DL を望まない場合のために、この挙動は README に明記する。クリエイターがファイルを差し替えると `downloads.fanbox.cc` のハッシュ名
  URL が変わるため、URL 不一致は「アーカイブが古い」ことを意味し、dedup を成立させず
  再ダウンロードする(旧レコードは新レコードで置き換え、`supersededAt` を記録)。
  これにより「done 済みの投稿が編集されても永久にスキップされ続ける」アーカイブ乖離を防ぐ。
  **URL 不変の in-place 差し替えへの備え(normative)**: 「バイトが変われば URL(ハッシュ名)も
  変わる」は Fanbox の実装観察に基づく仮定であり、保証ではない。このため done レコードには
  取得時点の `post.updatedDatetime` を `postUpdatedAt` として永続化する。再クリック時に
  現在の `updatedDatetime` がレコードより進んでいるのに該当ファイルの URL・relPath が
  一致(= dedup 成立)する場合、**黙ってスキップせず**「投稿は更新されていますが、この
  ファイルの URL は変わっていません。差し替えを確実に取り込むには 🔄(再DL)を使ってください」
  という通知を出す。このシグナルは 2 フィールドに分離する:
  **`lastDownloadedPostUpdatedAt`(実際にダウンロードした時のみ更新)**と
  **`lastWarnedPostUpdatedAt`(同一 updatedDatetime についての通知重複を抑止するためだけに
  更新)**。警告だけで前者を進めてはならない — さもないと通知を 1 回見逃しただけで
  「更新済みだがローカルが古い」状態が以後永久に沈黙する。判定は
  「現在の updatedDatetime > lastDownloadedPostUpdatedAt なら注意状態(警告対象)、
  ただし lastWarnedPostUpdatedAt と同値なら通知は再送しない。さらに新しい更新が来れば
  再度通知する」。注意状態は 🔄(force)による実ダウンロードでのみ解消される。
  自動での全ファイル再DL はしない(本文の誤字修正でも全帯域を再取得することになるため。
  ユーザーが 🔄 で明示的に選ぶ)。この通知経路(見逃し→再更新→再通知を含む)もテスト対象。
  この判定もフィクスチャテストでカバーする(URL 差し替え後の再クリックで該当ファイル
  だけ再 DL 対象になるケース、および URL 同一で `$seq` だけが変わるケース)。

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
    "matches": ["https://*.fanbox.cc/*"],
    "js": ["content/content-script.js"],
    "run_at": "document_idle"
  }],
  "web_accessible_resources": []
}
```

- `host_permissions` の `*.fanbox.cc` は api / downloads / www / クリエイターサブドメインを包含。
- postId 抽出: pathname `/posts/{id}`(両 URL 形式共通)。creatorId はサブドメインまたは `/@{slug}`。
- Fanbox は SPA のため、`www.fanbox.cc` 内遷移で URL が変わってもページリロードが起きない。
  content script は History API 遷移を検知(`popstate` + 定期 URL チェック)してボタンを再注入する。
  このため content script の matches は投稿 URL に絞らず **`https://*.fanbox.cc/*` 全域に常駐**させる
  (クリエイタートップで初期ロードされた SPA から投稿へ遷移するケースで、投稿 URL 限定の
  matches だと script 自体が存在せず §13-4 が構造的に通らないため)。ボタンの表示/非表示は
  script 内の URL 判定が行う。
  (fantia-dl は静的遷移前提だったため、ここは Fanbox 固有の追加要件)

## 13. MVP マイルストーン1で実施する確認(hard gate)

1. **(hard gate)** image / file 各 1 件で「直 URL → `downloads.download` 実保存」を実証。
   `saveAs: false` でダイアログ無し保存(Chrome 設定 OFF 時)も確認。
2. **(hard gate・§7a)** 有料投稿(加入後)で cookie 依存性を実証。403 なら明示エラーになることを確認し、§7a に従い一級市民フォールバックの**別 spec 化を起こす**(即時実装はしない)。
3. (履歴)当初の SW fetch gate は 2026-07-19 に **400 で失敗**(§4 実測)。canonical を
   content script isolated world fetch に変更し §13-6 を差し替えた。
4. SPA 内遷移(クリエイターページ → 投稿ページ)でボタン注入が働くか。
5. **(hard gate・§7b)** 無料投稿で zip モード E2E(SW ソース fetch → fflate → 実保存)。
   有料投稿分は §13-2 と同時に再実証。
6. **(hard gate・§4a)【2026-07-19 PASS】** **content script(isolated world)**
   からの `post.info` fetch が cookie 込みで 200 になること。walking skeleton v2 で実証済み
   (`origin=https://www.fanbox.cc status=200`)。これにより canonical 経路が確定し、
   `DownloadRequestMessage.json`(content script → SW)を committed interface とする。
   (履歴: v1 の SW fetch は api.fanbox.cc の Origin ゲートで 400 → content-script-canonical に変更)

## 14. 設定(options)・15. テスト方針・16. 技術スタック

fantia-dl §14〜16 と同一。

- 設定: テンプレート / zip モード / DL 履歴クリア。`chrome.storage.sync`。
  **`conflictAction` は設定項目として存在しない**(§8: uniquify 固定)。settings schema・
  options UI から完全に撤去し、background は `uniquify` を定数として渡す。
  settings 読み込み時に旧値・不正値として `conflictAction` が保存されていても無視する
  (= いかなる保存値も `uniquify` を変えられない migration 規則)。
- テスト: core は流用テストがそのまま green であること。`tests/parse.test.ts` は
  PoC で実測した JSON 構造のフィクスチャ(image / file / article / restricted / text)で TDD。
  **必須フィクスチャ**:
  1. 同じ imageId が非連続に 2 回出現する article(初出のみ採用・idemKey がユニーク)。
  1b. imageId と fileId が同じ文字列値を持つ article(種別判別子により別ジョブとして共存)。
  2. 「初回 DL と回復の間に投稿が編集・並べ替えされた」ケース(needs_page 回復が
     安定 ID で正しいファイルに再バインドし、消えた ID は明示エラーになる)。
- スタック: Bun + esbuild + vitest + tsc(strict)+ fflate。Nix flake + direnv。
  Renovate 設定(`.github/renovate.json`)もコピーし、初回の GitHub App 追加は shishi の手動 1 クリック。

## 17. fantia-dl からのコピー指針(実装プラン向け)

- そのままコピー(無改造が原則): `src/core/template-engine.ts` / `sanitizer.ts` /
  `path-validator.ts` / `base64.ts`, `src/offscreen/*`(zip 生成部),
  `public/offscreen/*`, `public/options/*`, `scripts/build.mjs`, `tsconfig.json`,
  `vitest.config.ts`, `flake.nix`, `.envrc`, `.github/*`, core 系 `tests/*`
- 書き換え: `src/fanbox/parse.ts`(新規 TDD), `src/fanbox/api.ts`(新規 TDD:
  fetchPostInfo は content script が呼ぶ / validatePostInfo は SW が呼ぶ §4a),
  `src/content/*`(URL・SPA 対応・CSRF 削除・**page script と注入機構を完全撤去** §4a・
  **post.info を isolated world で fetch し json を SW へ送る** §4a),
  `src/background/service-worker.ts`(=orchestrator 束縛。resolver 削除・
  **post.info fetch は持たず、受領 json を validatePostInfo で検証して parse** §4a・
  $plan マッピング・zip 用 SW fetch 追加 §7b・needs_page 経路は failure classifier 付きで
  維持 §6・§7c の reconcile/クリア保護), `src/background/job-store.ts`(§7c: single-writer キュー・
  原子的遷移・generation/lease/tombstone・件数上限 prune・set 失敗フェイルクローズ・
  選択的クリア), `src/core/settings.ts` / `src/core/types.ts` / `src/options/*` /
  `public/options/*`(§14: `conflictAction` の schema・UI・型からの撤去。core の他ファイル
  — template-engine / sanitizer / path-validator / base64 — は無改造コピー),
  `public/manifest.json`,
  `README.md`, `package.json`(name のみ)
- fantia-dl 側リポには一切手を入れない。
