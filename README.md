# document-locator

Google Drive をクロールして Supabase に検索インデックスを作る CLI です。
開発セットアップと運用コマンドをここにまとめています。

## まずは
- 前提: Node.js 22 以上、`pnpm` が使えること。
- 依存関係: `pnpm install`
- 環境変数: `.env.example` をコピーして `.env` を作成（詳細は下記）。
- 動作確認: `pnpm crawler -- --mode diff --limit 20` で乾式クロール。
  `pnpm search -- "キーワード"` で検索レスポンスを確認。

## 環境変数
サンプルはリポジトリ直下の `.env.example` にあります。
必須が欠けると起動時に例外を投げます。

### 必須
- `CRAWLER_MODE` — `auto|full|diff` のいずれか。開発は `diff` が安全。
- `SEARCH_MAX_LOOP_COUNT` — search の最大ループ回数（例: 3）。
- `SUMMARY_MAX_LENGTH` — 要約テキストの最大文字数（例: 400）。
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — Google OAuth。
- `GOOGLE_DRIVE_TARGET_FOLDER_IDS` — クロール対象フォルダ ID をカンマ区切りで
  渡す。
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Supabase の URL とサービスロールキー。
- `OPENAI_API_KEY` — 要約生成用の OpenAI API キー。

### 任意
- `OPENAI_ORG` — OpenAI 組織 ID。未指定ならデフォルト組織。
- `LOG_LEVEL` — `info|debug|error`。デフォルトは `info`。
- `TZ` — ログのタイムゾーン（例: `Asia/Tokyo`）。未指定なら OS 既定。
- `CRAWLER_USE_MOCK_SUPABASE` — `1` で Supabase 書き込みを避けるモックモード。
- `SUPABASE_DB_PASSWORD` — `pnpm db:apply` で DB パスワードが必要な場合のみ設定。

### 開発/本番の切り替え
`src/env.ts` は常にカレントディレクトリの `.env` を読みます。
用途別ファイルを用意し、実行前に `.env` へ差し替えてください。

```sh
# テンプレート作成
cp .env.example .env.development
cp .env.example .env.production

# 開発向け推奨値
sed -i '' 's/^CRAWLER_MODE=.*/CRAWLER_MODE=diff/' .env.development
sed -i '' 's/^LOG_LEVEL=.*/LOG_LEVEL=debug/' .env.development
echo 'CRAWLER_USE_MOCK_SUPABASE=1' >> .env.development

# 本番相当
sed -i '' 's/^CRAWLER_MODE=.*/CRAWLER_MODE=auto/' .env.production
sed -i '' 's/^LOG_LEVEL=.*/LOG_LEVEL=info/' .env.production

# 使いたい環境を選択（ln が難しければ cp でも可）
ln -sf .env.development .env   # 開発
# ln -sf .env.production .env  # 本番相当
```

## よく使うコマンド
- クロール（フル）: `pnpm crawler -- --mode full`
- クロール（差分）: `pnpm crawler -- --mode diff`
- 小規模デバッグ:
  `LOG_LEVEL=debug pnpm crawler -- --mode diff --limit 20`
  - Supabase 書き込みを避けたい場合は `CRAWLER_USE_MOCK_SUPABASE=1` を付ける。
- 検索: `pnpm search -- "議事録 メモ" --after 2024-01-01 --mime application/pdf`
  - 絞り込み不要なら `"キーワード"` だけで実行。
  - JSON ペイロードを見たい場合は `--json` を付ける。

### ログ例
```text
{"level":"info","message":"crawler: processed=8 skipped=2 upserted=8 failed=0"}
{"level":"debug","message":"drive_sync_state not found; running full crawl (auto mode)"}
```

## テストとスモーク
- 最小スモーク手順と検証観点: `docs/tasks/Phase_smoke.md`
- 推奨頻度: フェーズ6後半とフェーズ7前半に各1回、その後は週1夜間 CI。
- 成功条件サマリ:
  - アクセストークン更新とフォルダ列挙が成功し終了コード 0
  - 差分モードで modifiedTime フィルタを確認する
  - Doc/PDF 抽出と画像スキップログを確認する
  - upsert と drive_sync_state 更新が通り `smoke_output/` の後処理が完了する
- フルテスト: `pnpm verify`（format, lint, typecheck, test を一括実行）。

## 定期実行（10 分間隔 diff）
macOS 開発環境を想定。リポジトリ直下で差分クロールを 10 分ごとに実行。

### cron
```sh
mkdir -p ~/Library/Logs/document-locator
```

```
LOG=~/Logs/doc-locator.log
*/10 * * * * cd /path/to/document-locator && pnpm crawler -- --mode diff >> $LOG 2>&1
```

### launchd（ユーザーエージェント）
`~/Library/LaunchAgents/com.document-locator.crawler.plist` を作成し、
`launchctl load` で登録（初回のみ）。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.document-locator.crawler</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>cd /path/to/document-locator && pnpm crawler -- --mode diff</string>
    </array>
    <key>StartInterval</key>
    <integer>600</integer>
    <key>StandardOutPath</key>
    <string>/Users/you/Logs/doc-locator.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/Logs/doc-locator.log</string>
    <key>RunAtLoad</key>
    <true/>
  </dict>
</plist>
```

登録/起動:

```sh
mkdir -p ~/Library/Logs/document-locator
launchctl load -w ~/Library/LaunchAgents/com.document-locator.crawler.plist
```

停止や設定変更時は `launchctl unload -w ...` の後に plist を更新してください。

### ログ出力先とローテーション
- いずれの方法でも `~/Library/Logs/document-locator/crawler.log` へ追記。
- ローテーションする場合は `/etc/newsyslog.d/document-locator.conf` を作成。
  サイズ 1MB 到達または日次 7 世代保持の例（root 権限要）:

  ```
  /Users/you/Library/Logs/document-locator/crawler.log  644  7  1048576  *  @T00  Z
  ```

- 権限を避けたいなら `logrotate` を入れるか、CI でアーカイブ/削除ジョブを回す。

## トラブルシュート
障害時は `~/Library/Logs/document-locator/crawler.log` を `tail -f` し、`level=error` /
`http retry` の前後を確認。`LOG_LEVEL=debug` 再実行で原因が分かります。

### 認可エラー
- 典型ログ: `Failed to refresh Google access token`, `google drive request ... 401/403`,
  `Target folder not found`。
- 確認: `.env` の `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` と `GOOGLE_DRIVE_TARGET_FOLDER_IDS`
  に余計な空白がないか、対象フォルダがゴミ箱や共有外でないか。
- 復旧: `pnpm crawler -- --mode diff --limit 1` でも失敗する場合は、OAuth Playground で
  リフレッシュトークンを再発行して値を入れ替える。
  フォルダ ID を直して再実行。

### 429/5xx 多発
- 典型ログ: `http retry` が 1s→2s→4s→8s→16s と続き `HTTP 429/5xx` で終了。
- 確認: `url` フィールドで対象サービスを特定。
  同期間のステータスページや社内プロキシ障害を確認。
- 復旧:
  - 5～10 分待って `pnpm crawler -- --mode diff --limit 20` で再実行。
  - Google 403/429 が続く場合は間隔を伸ばすかフォルダを分割。
  - OpenAI 429 は使用量上限を確認し、必要なら API キーを切り替える。

### Supabase 5xx/重複
- 典型ログ: `Supabase request failed: 5xx` や
  `duplicate key value violates unique constraint "drive_file_index_pkey"`、
  または Supabase への `http retry`。
- 確認: `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` が正しく、有効期限切れでないか。
- 復旧: 一時的 5xx はリトライ後に `pnpm crawler -- --mode diff --limit 20` で再実行。
  重複が続く場合は Supabase SQL で該当 `file_id` を整理。
  その後 `pnpm crawler -- --mode full` で再構築。

## Google API 認証情報
1. Google Cloud コンソールでプロジェクトを作成（既存でも可）。
2. 「API とサービス > ライブラリ」で **Google Drive API** を有効化。
3. OAuth 同意画面でユーザータイプを External に設定し、Scope に
   `https://www.googleapis.com/auth/drive.readonly` を追加。
   実行ユーザーをテストユーザーに登録。
4. 認証情報 > 認証情報を作成 > OAuth クライアント ID で
   **アプリケーションの種類: ウェブ アプリケーション** を選ぶ。
5. 承認済みリダイレクト URI に `https://developers.google.com/oauthplayground` を追加。
6. 表示される **クライアント ID** と **クライアント シークレット** を
   `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` に転記する。

## リフレッシュトークン（GOOGLE_REFRESH_TOKEN）の取得
OAuth Playground を使うとブラウザだけで発行できます。
1. OAuth Playground を開き、「Use your own OAuth credentials」に `GOOGLE_CLIENT_ID` と
   `GOOGLE_CLIENT_SECRET` を入れて「Close」を押す。
2. Step 1 で Scope `https://www.googleapis.com/auth/drive.readonly` を入力し「Authorize APIs」。
   対象アカウントでログインし、アクセス許可を承認する。
3. Step 2 で「Access type: offline」「Force prompt: consent」を選び「Exchange authorization code for
   tokens」をクリック。
4. 下部レスポンスに表示される `refresh_token` の値を `GOOGLE_REFRESH_TOKEN` として `.env` に保存。

### メモ
- 承認に使うアカウントは、クロール対象の Drive フォルダへアクセス権を持つものを選ぶ。
- 再発行は Step 2 で `Force prompt: consent` を有効にして再交換する。
- `redirect_uri_mismatch` の場合、リダイレクト URI と「ウェブ アプリケーション」種別を確認。

## 追加ドキュメント
- 設計ノートやランブック: `docs/` ディレクトリを参照。
- SQL スキーマ: `sql/` の DDL を `pnpm db:apply` で適用可能。
