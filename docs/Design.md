# Google Drive 検索 CLI 設計書（PoC）

本書は「生成AIとベクトル検索を活用した Google Drive 検索システム（PoC）」の基本設計をまとめる。  
PoC の目的は「ヒット件数に応じて検索手段を切り替えるハイブリッド検索」の有効性を最小実装で検証することである。docs/Requirements.md の要件を実装に落とせる粒度まで具体化する。

## 1. 全体アーキテクチャ

- CLI 2本構成  
  - `crawler`: Google Drive を巡回し Supabase にインデックスを作る。Cron から実行可能。  
  - `search`: 自然文クエリを受け取り、ヒット件数に応じて Drive 検索 / ベクトル検索 / LLM リランキングを切り替える。
- 外部サービス  
  - Google Drive API（検索・メタデータ・本文取得）  
  - OpenAI: GPT-4o mini（要約/キーワード/質問生成/リランキング）、text-embedding-3-small（ベクトル化）  
  - Supabase（PostgreSQL + pgvector）: `drive_file_index`, `drive_sync_state`
- 設定: `.env` に環境変数を集約（後述）
- サポート OS: macOS（PoC のみ）。Linux/Windows は非サポート。

### 1.1 データフロー（文章による図示）
1. クロール起動（手動 or Cron）  
2. Google Drive API からターゲットフォルダ配下を列挙 → テキスト抽出  
3. LLM 要約 + キーワード生成 → Embedding 生成  
4. Supabase へ Upsert（`drive_file_index`）＆ `drive_sync_state` 更新  
5. 検索 CLI でクエリ受領 → LLM でキーワード抽出  
6. Drive API で全文検索 → `drive_file_index` との積集合を算出（ヒット件数）  
7. 件数別にベクトル検索／リランキング／追加質問生成を選択  
8. 結果を CLI 出力

## 2. コンポーネント設計

### 2.1 CLI 共通基盤
- 言語/ランタイム: Node.js 22 + TypeScript 5 を採用。  
- パッケージマネージャ: `pnpm`。スクリプト実行は `tsx` を使用。  
- CLI フレームワーク: `commander`。  
- 開発ツール: lint/format は `biome`、テストは `vitest`。  
- 共通モジュール例  
  - `env`: `.env` を読み込みバリデーションする。必須項目欠如時は起動エラーで終了。  
  - `logger`: コンソール出力ベース。`INFO/ERROR/DEBUG`。Cron 運用を考慮し 1 行で完結するメッセージを心掛ける。  
  - `googleDriveClient`: 認証済み Drive API クライアント生成。`GOOGLE_DRIVE_TARGET_FOLDER_IDS` スコープ限定ユーティリティを含む。  
  - `openaiClient`: GPT-4o mini / text-embedding-3-small 呼び出しラッパー。  
  - `supabaseClient`: DB 接続と Upsert/検索ユーティリティ。  
  - `time`: `modifiedTime` の比較、RFC3339 ⇔ TZ 変換ヘルパー。

### 2.2 Google Drive クローラー（`crawler` コマンド）
- 目的: Drive 配下のテキスト取得可能ファイルをインデックス化し、ベクトル検索用データを Supabase に蓄積する。
- 入力: `.env` の `GOOGLE_DRIVE_TARGET_FOLDER_IDS`, Supabase 接続情報, OpenAI API Key, `SUMMARY_MAX_LENGTH` 等（`CRAWLER_MODE` によるデフォルト動作指定を含む）。
- 出力: `drive_file_index` Upsert、`drive_sync_state.drive_modified_at` 更新、実行ログ。
- コマンド例: `document-locator crawler --mode=auto`  
  - `--mode=full` 強制フルスキャン  
  - `--mode=diff` 差分のみ（デフォルト auto: `drive_sync_state` が無ければ full）  
  - `--limit` デバッグ用サンプル件数制限
  - `--mode` を省略した場合は `CRAWLER_MODE` をデフォルトとして使用し、CLI で `--mode` が指定された場合は環境変数を上書きする。
- 処理シーケンス
  1. ターゲットフォルダ存在確認。失敗時は即エラー終了。  
  2. フル or 差分判定  
     - フル: ターゲットフォルダ ID 群をキュー初期化し、FIFO で取り出したフォルダに対し
       `files.list` を実行。レスポンス中の「サブフォルダ」をキューへ追加しつつ、同じ
       レスポンスに含まれるファイルも収集する。キューが空になるまで繰り返し、子孫階層を
       すべて走査する。  
     - 差分: 上記と同じ再帰列挙を行うが、クエリに `modifiedTime >
       drive_sync_state.drive_modified_at` を付与して更新分のみ取得。  
  3. テキスト抽出  
     - Google ドキュメント: `files.export`(mimeType=text/plain)  
     - PDF: `files.get`(alt=media) でバイナリ取得 → `pdf-parse` でテキスト抽出（`files.export` は PDF では 400 になるため使用しない）  
     - Microsoft Word (.docx): `files.get`(alt=media) でバイナリ取得 → `mammoth` 等でプレーンテキスト化  
     - プレーンテキスト/Markdown/CSV: MIME `text/plain` / `text/markdown` / `text/csv` を `files.get` で取得し、そのまま UTF-8 文字列として扱う  
     - Google スプレッドシート: `files.export`(mimeType=text/csv) で CSV に変換してからテキスト扱い  
     - OCR は非対応。非テキスト対象（画像/zip 等）はスキップ。  
  4. AI 処理  
    - GPT-4o mini: 要約 `summary`（`SUMMARY_MAX_LENGTH` 以内に truncate）、キーワード 1〜5 件。  
     - `summary + keywords + file_name` を結合し text-embedding-3-small で 1536 次元ベクトル生成。  
  5. DB Upsert  
     - `drive_file_index` に `file_id` PK で挿入/更新。  
     - 処理対象の最大 `modifiedTime` を `drive_sync_state.drive_modified_at` に保存。  
  6. 終了コード  
     - 正常: 0 / エラー: 非0。Cron 用に短文ログを残す。
- エラー/リトライ方針  
  - Drive API 429/5xx: exponential backoff（1s → 2s → 4s → 8s → 16s、最大 5 回）。  
  - OpenAI 429/5xx: 同上。  
  - 個別ファイル失敗時は警告ログでスキップし処理継続、バッチ全体を止めない。  
  - DB 失敗時は再試行し、それでも失敗したレコードはエラー終了で検知可能にする。

### 2.3 セマンティック検索 CLI（`search` コマンド）
- 目的: 自然文クエリに対しヒット件数で検索手段を選択し、関連度の高い Drive ファイルを列挙する。
- 入力: クエリ文字列。オプションで期間（`--after`, `--before`）、MIME（`--mime`）。  
- 出力: ファイル名・要約・Drive リンク。ヒット件数に応じたメッセージ。
- コマンド例:  
  - `document-locator search "週次レポート 9月 売上"`  
  - `document-locator search --after=2024-09-01 --before=2024-09-30 --mime=application/pdf "レポート"`
- 処理フロー
  1. クエリ解析  
     - 日付/期間と MIME をパース。  
    - GPT-4o mini で 1〜5 件の検索キーワード抽出（固有名詞優先）。  
  2. 初期検索（Drive API）  
     - `GOOGLE_DRIVE_TARGET_FOLDER_IDS` 配下限定で全文検索。期間/MIME フィルタ適用。  
  3. ヒット件数算出  
     - Drive 検索結果の `file_id` と `drive_file_index` 既存 `file_id` の積集合サイズを「ヒット件数」とする。  
  4. 分岐ロジック  
     - **101 件以上**: 上位結果を LLM に渡し「追加質問」を生成 → ユーザー入力 → 追加キーワード/フィルタ生成 → 再検索。  
     - **11〜100 件**: 「クエリ+キーワード」を embedding 化し、積集合のみに対してベクトル検索（上位 10 件）。得られた件数を次ステップのヒット件数とする。  
     - **2〜10 件**: LLM に要約+メタデータを渡しリランキング → 上位順に表示。  
     - **1 件**: そのまま表示して終了。  
     - **0 件**: キーワード削減 or フィルタ緩和を LLM に指示し再検索。キーワード 1 件でも 0 の場合は「見つかりませんでした」。  
  5. ループ制御  
     - 上記以外は再度 2〜4 を繰り返す。最大ループ回数は `SEARCH_MAX_LOOP_COUNT`（`.env`）。上限到達時に 11 件以上残存なら「10 件以下に絞り込めませんでした」メッセージで終了。
- 出力フォーマット例  
  ```
  [1] 顧客A_週次レポート_2024-09-10.pdf
      要約: 9月2週の売上サマリーと課題...
      Link: https://drive.google.com/open?id=xxxxx
  ```

### 2.4 LLM プロンプト方針（概要）
- キーワード抽出: 固有名詞・プロジェクト名・拡張子を優先し 1〜5 件。出力形式は JSON 配列（例: `["Foo","Bar"]`）。  
- 追加質問生成: ヒット上位の要約を渡し、「絞り込みに効く 1 問」を生成。  
- リランキング: 「ユーザーの意図に合致する順」を返させ、順位付きで受け取る。  
- キーワード緩和: 0 件時にキーワード数を 1 ずつ減らす or 期間/MIME を外す提案を生成。  
- モデル設定（共通）: GPT-4o mini に対し `temperature=0.0`, `max_tokens=400` を指定し、生成量をトークン単位で抑制したうえで、受信後に `SUMMARY_MAX_LENGTH`（例: 400）文字で truncate する二段制限とする。

## 3. データベース設計（Supabase / PostgreSQL + pgvector）

### 3.1 テーブル定義
```sql
-- drive_file_index
file_id           TEXT PRIMARY KEY,
file_name         TEXT NOT NULL,
summary           TEXT NOT NULL,
keywords          TEXT[] NULL,
embedding         VECTOR(1536) NOT NULL, -- text-embedding-3-small の次元数に固定
drive_modified_at TIMESTAMPTZ NOT NULL,
mime_type         TEXT NOT NULL;

-- drive_sync_state
id                TEXT PRIMARY KEY,   -- 'global' 固定
drive_modified_at TIMESTAMPTZ NOT NULL;
```

### 3.2 インデックス/パーティション案（PoC 想定）
- `drive_file_index(file_id)` は PK でカバー。  
- `drive_file_index(drive_modified_at)` に BTree を張り差分クロールを高速化。  
- pgvector 用に `USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100, probes = 10)` を初期値とする（embedding は `vector(1536)` で固定。モデル変更時は次元を合わせてマイグレーションする）。PoC で無理なら L2 替えでも可。  
- `drive_sync_state.id` は単一行。初期値が無い場合はフルスキャン扱い。
- セマンティック検索時のパラメータ: 検索 `k=20` の上位から 10 件を出力。

## 4. 設定・環境変数
- **必須（実際の採用値）**  
  - `CRAWLER_MODE=diff`（CLI `--mode` があればそちらを優先）  
  - `SEARCH_MAX_LOOP_COUNT=3`  
  - `SUMMARY_MAX_LENGTH=400`  
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`  
  - `GOOGLE_DRIVE_TARGET_FOLDER_IDS`（カンマ区切りで複数可）  
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`（スキーマは `public` 固定）  
  - `SUPABASE_DB_PASSWORD`（PostgreSQL 直結・マイグレーション用の DB パスワード）  
  - `OPENAI_API_KEY`  
  - `LOG_LEVEL=info`
- **任意**: `OPENAI_ORG`、`TZ=UTC`（modifiedTime 比較を安定させるため推奨）
- 環境変数が欠落した場合は起動時にエラー終了し、欠落キー名を明示する。

推奨テンプレート（値はダミー）:
```
CRAWLER_MODE=diff
SEARCH_MAX_LOOP_COUNT=3
SUMMARY_MAX_LENGTH=400

GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxx
GOOGLE_REFRESH_TOKEN=1//xxxx
GOOGLE_DRIVE_TARGET_FOLDER_IDS=1abcDEFghiJKLmn,1zzzYYYxxxWWW

SUPABASE_URL=https://abcxyz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_DB_PASSWORD=super-secret-db-password

OPENAI_API_KEY=sk-proj-xxxx
OPENAI_ORG=org_123456
LOG_LEVEL=info
TZ=UTC
```

### 4.1 マイグレーション運用
- `sql/` 配下に手書き SQL を配置し、`pnpm db:apply` で適用する簡易運用とする。

## 5. 外部サービス接続ポリシー
- Google Drive API: ユーザー本人の認証情報のみ使用。サービスアカウントは非対象。  
- API レートリミット: 429 時は backoff。`files.list` は 100 件ページングで取得。  
- OpenAI: rate-limit/timeout をハンドリング。prompt と token 使用量はログに残す（デバッグモード時）。

## 6. 運用・ジョブ設計
- Cron 例（macOS `crontab`）  
  - `*/10 * * * * cd /path/to/repo && document-locator crawler --mode=diff >> /tmp/document-locator.log 2>&1`  
- 手動実行時は verbose ログを有効化して調査を容易にする。  
- フルスキャン再実行条件  
  - `drive_sync_state` が空の場合  
  - `--mode=full` を指定した場合
- 配布・実行形態: ローカル実行のみを想定。`pnpm dlx tsx src/crawler.ts` / `src/search.ts` もしくは `pnpm crawler` / `pnpm search` スクリプト経由で起動する。

## 7. ロギング / エラーハンドリング
- ログレベル: `INFO`（デフォルト）、`DEBUG`（詳細）、`ERROR`。  
- 各ステップの件数を残す（取得件数、スキップ件数、Upsert 件数、ベクトル検索件数など）。  
- CLI 終了コードで異常を検知可能にする。  
- 例外時はユーザーが対処しやすいメッセージを出し、スタックトレースは DEBUG でのみ表示。
- 並列度とリトライ: Drive / OpenAI への同時リクエストは最大 5。本番 API 429/5xx 時は指数バックオフ（1s → 2s → 4s → 8s → 16s、最大 5 回）を行う。部分失敗はログに残して処理継続し、致命的な場合のみ非0終了とする。

## 8. セキュリティ方針
- シングルユーザー前提。トークンや鍵は `.env` にのみ保存し、リポジトリには含めない。  
  - クエリ時に扱う Drive ファイルは Drive API が返したものと `drive_file_index` 積集合に限定し、他ユーザーのファイルが混入しないようにする。  
  - LLM へ渡すコンテキストは最小限（要約＋メタデータ）に留め、機密データの流出リスクを低減。

## 9. テスト方針（PoC レベル）
- ユニット:  
  - キーワード抽出プロンプトの出力フォーマット（JSON など）検証。  
  - ヒット件数分岐ロジック（モックデータで 0/1/5/50/120 をカバー）。  
  - 差分クロールで `drive_sync_state` を跨いだ日時比較。  
- 結合/手動:  
  - 小規模フォルダでフル → 差分の動作確認。  
  - 画像ファイルがスキップされること。  
  - ループ上限到達時メッセージ確認。  
- 負荷は PoC では対象外。

## 10. 既知の制約と今後の改善アイデア
- Drive の削除/移動/権限変更はインデックスに残りうる（PoC ではクリーンアップを行わない設計上の許容）。
- 大量ヒット時の追加質問 UX は CLI 入力に依存。将来は対話モードや Web UI、キャッシュ導入を検討。  
- Embedding モデルや LLM は将来的な差し替えを許容するため、呼び出しラッパーをインターフェース化する。  
- pgvector のチューニング（lists/probes）は件数増大に伴い再計測が必要。
- 既知の実装ギャップ: 現行コードはターゲットフォルダ直下のみ列挙しており、ここで記述した

## 11. 実装タスクの目安（優先度順）
1) 環境変数ロード＆バリデーション  
2) Supabase スキーマ作成＆クライアントラッパー  
3) Google Drive クライアント + テキスト抽出  
4) OpenAI ラッパー（要約/キーワード/embedding）  
5) クローラー CLI（full/diff、Upsert）  
6) 検索 CLI（キーワード抽出→Drive検索→件数分岐→ベクトル検索→リランキング）  
7) ログ/エラー整理、簡易テストデータ投入  
8) Cron サンプルと README 追記

以上。
