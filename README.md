# fanbox-dl

pixivFANBOX の投稿(自分がアクセス権を持つコンテンツ)をテンプレート命名で自動ダウンロードする Chrome 拡張。個人アーカイブ用。姉妹プロジェクト: [fantia-dl](https://github.com/shishi/fantia-dl)。

## セットアップ

ツールチェーンは Bun 専用(Node.js 不要)。

```
bun install && bun run build
```

Nix + direnv の場合は `direnv allow` で Bun 入りの shell が立つ。

### 拡張のインストール

1. `dist/` を `chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」で指定
2. Chrome 設定「ダウンロード前に各ファイルの保存場所を確認する」を **OFF** にする(ON だとダイアログが出る。拡張からは抑制できない)

## 使い方

投稿ページ右下の「⬇ fanbox-dl」をクリック。保存先はオプションのテンプレートで決まる。

- **⬇**: 通常ダウンロード。DL 済みの項目は履歴でスキップ
- **🔄**: この投稿を新しい世代として再ダウンロード(履歴は消さず世代交代。旧ファイルは自動では消えない)

## テンプレート

`$creator $creatorId $postTitle $postId $date{YYYYMMDD} $today{} $contentId $contentType $plan $filename $ext $seq $seq{3} $total` とオプショナルグループ `[ ... ]`。

- `$contentId` は投稿内のメディアブロック通し番号("1", "2", …)
- `$plan` は投稿の必要支援額(feeRequired。例 "0", "500")
- `$contentTitle` は Fanbox に存在しないため常に空(`[...]` に入れると丸ごと消える)

既定: `fanbox/$creatorId/$date{YYYYMMDD}_$postTitle/[$seq{3}_]$filename.$ext`

## 知っておくこと

- **世代付き命名**: クリエイターがファイルを差し替えたり、テンプレート入力が変わったりして再取得が必要になると、`foo.rev1.jpg` のようなバージョン付きの名前で保存される(既存ファイルの無言上書きは決して起きない)。テンプレートを変更すると既存ファイルが「新世代」として再ダウンロードされ得る
- **投稿更新の通知**: DL 済み投稿が更新されたのにファイル URL が変わっていない場合、黙ってスキップせず通知を出す。確実に取り込みたいときは 🔄
- **zip モード**(既定 ON): 2 枚以上の画像ギャラリーはブロック単位で 1 zip(`images_$contentId.zip`)。zip は**再開不可の一括処理**で履歴に残らない。大きい投稿や確実性が要る場合は通常 DL 推奨(zip にできない場合は自動で個別 DL に切り替わる)。ソース合計 100MB / 100 件が上限。**zip 保存自体が失敗した場合は Chrome のダウンロード一覧に失敗として表示され、拡張の Service Worker console にも「zip は最初からやり直し。確実性が要るなら通常 DL を。」が記録される**(部分 zip は残らない。⬇ を押し直すと最初から zip を作り直す)
- **DL 履歴**: `chrome.storage.local` に保存(1 年 / 5,000 件で自動整理)。options から全クリア可能

## 依存関係の自動更新

Renovate(`.github/renovate.json`)。リポを GitHub に作ったら [Renovate App](https://github.com/settings/installations) の Repository access に `fanbox-dl` を追加する(手動 1 クリック)。
