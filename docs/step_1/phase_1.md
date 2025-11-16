# Phase 1 タスク (DB/永続化レイヤー)

Phase 1 は Day 1-2 で永続化レイヤーを固め、クローラー/検索両CLIのベースとなる DB 接続・スキーマ・リポジトリ API を完成させることがゴール。docs/Plan.md の Phase 1 ブロックをタスク化し、成果物と受入基準を整理する。

## タスクリスト概要

| ID   | タスク名                                        | 目的/主要成果物                                                     |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------- |
| T1-1 | Supabase 接続モジュールと repository 設計       | 接続設定/ローテータブルな `db/repositories.py` 下層インターフェース |
| T1-2 | 初期マイグレーション (`0001_init.sql`) の整備   | `file_index` / `crawler_state` スキーマとインデックス               |
| T1-3 | Repository 実装 (Upsert/検索/削除/APIキー切替)  | CRUD API                                                            |
| T1-4 | Repository テストと接続周辺の検証ユーティリティ | Upsert/Search/Delete のテスト、テスト用接続フィクスチャ             |

## タスク詳細

### T1-1: Supabase 接続モジュールと repository 設計
- **作業内容**
  - `app/db/client.py` (仮) に接続モジュールを実装し、サービスアカウントキー/ユーザー API キーを設定で切り替え可能にする。Plan Phase 1 で言及された「接続はサービスアカウントキー/ユーザー API キーで切り替え可能」を満たす設計。
  - uv/psycopg などで再利用できる接続ファクトリと context manager (`get_connection(mode="service"/"user")`) を用意し、`db/repositories.py` だけでなくテストからも再利用できるようにする。
  - Supabase 側の URL/DB 名/スキーマを `.env`/config ローダーとつなぎ、Phase 0 の設定モジュールと統一された名前空間で取得できるようにする。
  - Phase 0 で `app/config/__init__.py` を更新し、`SupabaseConfig` に anon/user key を追加する。具体的には `.env.sample` と `_PATH_TO_ENV_KEY` に `SUPABASE_ANON_KEY` (もしくは `SUPABASE_USER_API_KEY`) を追加し、`python -m app.config doctor` が新フィールドを検証できるようにしておく。
  - `.env.sample` には DB 名/スキーマ名も事前に定義しておく。推奨値: `DATABASE_NAME=document_locator`, `DATABASE_SCHEMA=document_locator_app`, `SUPABASE_SERVICE_ROLE_KEY=service-role-xxxxx`, `SUPABASE_ANON_KEY=public-anon-xxxxx`。これらを Plan/README と揃え、後続タスクで命名議論が発生しないようにする。
  - コネクションプール (psycopg `ConnectionPool` など) を使い、Phase 2 での高頻度アクセスを想定したエラーハンドリング (再接続、タイムアウト設定、構造化ログ) を下駆けとして組み込む。
- **受入基準**
  - CLI から `python -m app.db.client doctor --mode service` のようなテストフックを実行し、接続→簡易クエリ (`select 1`) を成功させられる。
  - 設定値が欠落した場合にわかりやすい例外 (`ConfigError`) を発生させ、Phase 0 の設定ドクタで確認できる。
  - 接続モジュールの Docstring か README の DB セクションに、モード切替方法と利用例が明記される。

### T1-2: 初期マイグレーション (`0001_init.sql`) の整備
- **作業内容**
  - `app/db/migrations/0001_init.sql` を作成し、Plan 記載の `file_index` と `crawler_state` を定義。pgvector 拡張 (`create extension if not exists vector;`) の有効化も含める。
  - `file_index` テーブル: `file_id PK`, `drive_id`, `file_name`, `summary`, `keywords`, `embedding vector(1536)`, `mime_type`, `last_modifier`, `updated_at`, `deleted_at`。Plan のリスク緩和に合わせて `idx_file_index_drive_file` などの副索引を追加し、ACL テーブル追加を見据えたスキーマコメントを付記する。
  - pgvector 用のハイブリッドインデックスを追加 (例: `create index file_index_embedding_idx on file_index using ivfflat (embedding vector_l2_ops) with (lists = 100);`)。Supabase 側パラメータは設定値から調整できるようにコメント化。
  - `crawler_state` テーブル: `drive_id` PK、`start_page_token`, `last_run_at timestamp with time zone`, `last_status text`, `updated_at timestamp with time zone default now()` を含め、差分クローリングの状態を管理。
  - マイグレーション実行スクリプト (`scripts/migrate.py` or `make migrate`) から idempotent に適用できるよう SQL を構成し、ローカル Supabase もしくは test DB で Dry-run を行う。
- **受入基準**
  - `uv run scripts/migrate.py up` などのコマンドで初期スキーマが作成され、再実行しても差分が出ない。
  - `\d file_index` / `\d crawler_state` (psql) で Plan 記載カラムが揃い、pgvector インデックスと副索引が存在する。
  - README または `docs/Design.md` の DB セクションに、マイグレーション適用手順と主要テーブルの説明が追記される。

### T1-3: Repository 実装 (Upsert/検索/削除/APIキー切替)
- **作業内容**
  - `db/repositories.py` に `FileIndexRepository` (upsert/search/delete), `CrawlerStateRepository` (CRUD) を実装。
  - Upsert は複数行をまとめて処理する `upsert_files(files: Sequence[FileRecord])` を提供し、`deleted_at` が `not null` の場合は論理削除扱いに統一。Plan Phase 2 の同期処理でまとめて呼べるようバルクSQLを採用。
  - 検索 API は `embedding` ベクトルとの距離計算 (`<->` 演算子) を行う SQL をラップし、`limit`, `min_similarity` を引数としてパラメトライズ。pgvector インデックスを活かすため Prepared Statement 化し、必要に応じて RPC (Supabase) 呼び出しとも親和性を持たせる。
  - 削除 API は `file_id` 単位で `deleted_at` を更新し、Plan の「削除イベント処理」と連携できるよう設計。`drive_id` での範囲削除にも対応。
  - 例外整理: DB 側エラー (`psycopg.Error`) をアプリ固有例外 (`RepositoryError`) にラップし、ログ出力フォーマット (構造化) を Phase 0 の logging モジュールに合わせる。
- **受入基準**
  - 署名/Docstring が Phase 2/3 から利用しやすいよう型ヒントつきで提供される。
  - 接続モジュールのモード切替 (`service` vs `user`) が repository 層でも透過的に利用できる (例: 引数 `connection_mode="service"` が機能)。

### T1-4: Repository テストと接続周辺の検証ユーティリティ
- **作業内容**
  - `tests/db/test_repositories.py` を作成し、ローカル Supabase/Postgres をモックまたは test コンテナで起動して Upsert/Search/Delete を検証。`pytest` マーカーで DB テストを分類し、CI で実行できるようにする。
  - `crawler_state` リポジトリの CRUD と `start_page_token` の差分更新が想定どおり動くかをシナリオテストで検証。
  - DB 接続フィクスチャを pytest で実装 (`@pytest.fixture(scope="session")`) し、接続設定が存在しない場合は `pytest.skip` で安全にスキップ。CI では Supabase service key を渡して実行できるように GitHub Actions Secrets を設計。
- **受入基準**
  - `pytest tests/db/test_repositories.py -k file_index` がローカルで成功し、CI でも安定実行される。
  - テストログに API キーなどの秘密情報が出力されない (NFR-SEC-02)。
