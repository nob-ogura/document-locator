# document-locator

[![CI](https://github.com/nob-ogura/document-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/nob-ogura/document-locator/actions/workflows/ci.yml)

## ローカル開発環境のセットアップ

このリポジトリでは [uv](https://docs.astral.sh/uv/) を使って **Python 3.13** を標準化しています。

1. uv がまだインストールされていなければ導入します。
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
2. このリポジトリ用に Python 3.13 のツールチェーンを用意して固定します。
   ```bash
   uv python install 3.13
   uv python pin 3.13
   ```
3. 仮想環境と依存関係（開発ツール込み）をブートストラップします。
   ```bash
   uv sync
   ```
4. 日常作業には `Makefile` のヘルパーを利用します。
   - `make lint` &rarr; `ruff check` + `black --check`
   - `make format` &rarr; `black` による自動整形
   - `make typecheck` &rarr; `mypy`
   - `make test` &rarr; `pytest`

`app/` ディレクトリには後続フェーズで実装を進める Python パッケージ（`gdrive_indexer`, `gdrive_search`）があります。`tests/` には対応するユニットテストが、`scripts/` にはアドホックな自動化スクリプトが配置されます。

## CI

`main` ブランチへの push と Pull Request は GitHub Actions の `CI` ワークフローで自動的に `uv sync` を行い、`ruff`, `black --check`, `mypy`, `pytest` を走らせます。ローカルと同じ `make` コマンドで再現できるので、失敗したチェックは手元で `make lint && make typecheck && make test` を実行して確認してください。

## Phase 0 Secrets & Environment Variables
`docs/step_1/phase_0.md` では Phase 0 のタスクを着手する前に、Google API 認証情報や OpenAI/Supabase のキーを `.env.sample` に整理しておくことが求められています。以下に必要な変数と、それぞれの入手手順をまとめます。

| 変数名                                                 | 入手元                                           | 用途                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GOOGLE_APPLICATION_CREDENTIALS`                       | Google Cloud のサービスアカウント JSON           | gdrive-indexer (共有ドライブ巡回) で Drive API を呼び出すためのサービスアカウント資格情報                   |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud の OAuth 2.0 クライアント           | gdrive-search でユーザー本人の Drive 権限を取得するためのOAuthクライアント設定                              |
| `OPENAI_API_KEY`                                       | OpenAI アカウント                                | GPT-4o mini と text-embedding-3-small を叩くための API キー                                                 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Supabase プロジェクト Settings > API             | Supabase/PostgreSQL への HTTP 経由アクセス。サービスロールはインデックス更新で Upsert/Delete を行い、Anon key はユーザー向け RLS アクセスで使用 |
| `DATABASE_URL`, `DATABASE_NAME`, `DATABASE_SCHEMA`     | Supabase Settings > Database > Connection string | 直接 PostgreSQL に接続する CLI/テストで利用する接続文字列と、アプリ用データベース/スキーマ (例: `document_locator_app`) |

### 1. Google Drive クローラー用サービスアカウント (`GOOGLE_APPLICATION_CREDENTIALS`)
1. [Google Cloud Console](https://console.cloud.google.com/) で専用プロジェクトを作成し、**Drive API** (必要に応じて **Admin SDK**) を有効化します。
2. IAM & Admin > サービスアカウントから「サービスアカウントを作成」を選択し、名前と説明を入力して作成します。
3. Drive のファイル内容を参照できるロール（例: プロジェクト > エディタ）を割り当てます。Workspace 全体にアクセスさせる場合は**ドメイン全体の委任**を有効化し、必要スコープ（`https://www.googleapis.com/auth/drive.readonly` など）を Workspace 管理コンソールで承認します。委任を使わない場合は、対象の共有ドライブにこのサービスアカウントを「コンテンツ管理者」として追加してください。
4. 「キーを追加」>「JSON」を選択し、ダウンロードされた JSON をリポジトリ外の安全な場所に保存します。macOS であれば `~/.config/document-locator/credentials/` のような専用ディレクトリをホーム下に作成し、ディレクトリは `chmod 700`、JSON ファイルは `chmod 600` で権限を絞るのが一般的です。
   ```bash
   install -d -m 700 ~/.config/document-locator/credentials
   install -m 600 ~/Downloads/google-service-account.json ~/.config/document-locator/credentials/service-account.json
   ```
   そのパスを `GOOGLE_APPLICATION_CREDENTIALS` に設定しておくと、アプリからも安全に参照できます。
5. ローカルで `export GOOGLE_APPLICATION_CREDENTIALS=~/.config/document-locator/credentials/service-account.json` のようにファイルパスを環境変数に設定します。

### 2. 検索 CLI 用 OAuth クライアント (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`)
1. 同じ Google Cloud プロジェクトの「API とサービス > OAuth 同意画面」でユーザータイプを **内部** に設定し、アプリ名やサポート情報を入力、テストユーザーに想定利用者のアカウントを追加します。
2. 「認証情報」>「認証情報を作成」>「OAuth クライアントID」を選択し、アプリケーションの種類に **デスクトップ アプリ**（CLI向け）を指定します。ブラウザリダイレクト方式を採用する場合は `http://localhost:<port>/oauth2callback` を許可リダイレクトURIに登録してください。
3. 作成後に表示される **クライアントID** と **クライアントシークレット** を控えます。Drive メタデータ取得に必要なスコープ（`https://www.googleapis.com/auth/drive.metadata.readonly` や `drive.readonly`）を同意画面に追加しておくと、CLI からの認可時に追加権限が不要になります。
4. `.env` あるいは個人設定ファイルに以下のように記述します。
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=xxxxxxxxxxxxxx
   ```

### 3. Supabase 接続情報 (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `DATABASE_NAME`, `DATABASE_SCHEMA`)
1. [Supabase](https://supabase.com/) で新規プロジェクトを作成し、PostgreSQL パスワードとリージョンを決定します。プロジェクト作成後、Database > Extensions から **pgvector** を有効化してください。
2. Settings > API で **Project URL** (`https://<ref>.supabase.co`)、**service_role key**、**anon/public key** を取得します。Project URL を `SUPABASE_URL`、Service Role Key を `SUPABASE_SERVICE_ROLE_KEY`、Anon key を `SUPABASE_ANON_KEY` として `.env`/.toml に記載します。
3. Supabase の `Settings > Database > Connection string` から `DATABASE_URL` をコピーし、CLI やスクリプトが直接 PostgreSQL に接続できるようにします（例: `postgresql://postgres:<password>@db.<ref>.supabase.co:6543/postgres`）。同時に Phase 1 で利用する論理データベース名 (`DATABASE_NAME=document_locator`) とアプリ用スキーマ (`DATABASE_SCHEMA=document_locator_app`) も決めておきます。Supabase プロジェクトはデフォルトで `postgres` データベースしか持たないため、推奨名で運用する場合は自分で論理 DB/スキーマを 1 度だけ作成する必要があります。接続文字列の DB（通常は `postgres`）に psql/pgcli などで接続し、以下を実行してください。
   ```sql
   create database document_locator;
   \c document_locator
   create schema document_locator_app authorization current_user;
   ```
   Supabase の SQL Editor で実行しても構いません。`DATABASE_NAME` を `postgres` にしておけば追加作業は不要ですが、このプロジェクトの移植性を考えると専用 DB/スキーマを作成しておくことを推奨します。
4. 取得したキーはローカルだけに保存し、Git には絶対に含めないようにしてください。必要に応じて Supabase 側で IP 制限やパスワードのローテーションを設定します。

### 4. OpenAI API キー (`OPENAI_API_KEY`)
1. [OpenAI](https://platform.openai.com/) のアカウントにログインし、[API Keys](https://platform.openai.com/api-keys) から「Create new secret key」を実行します。
2. プロンプト処理で **GPT-4o mini**、埋め込みで **text-embedding-3-small** を利用できるプランであることを確認してください。必要に応じて課金方法を登録します。
3. 作成直後に表示されるキーをコピーし、`.env` またはシークレットマネージャーに `OPENAI_API_KEY=sk-...` として保存します。

### 5. `.env` 作成と検証
1. `.env.sample` が追加されたら `cp .env.sample .env` を実行し、上記で取得した値を `.env` に転記します。JSON ファイル（サービスアカウント鍵）はパスのみ記載し、ファイル自体は `.gitignore` された場所に置きます。
2. Phase 0 で実装予定の `python -m app.config doctor` コマンドが完成したら、`.env` の検証に使用してください。欠けている変数やファイルのパスミスが早期に検出できます。
3. これらのシークレットを共有する場合は、パスワードマネージャーや Vault を通じて共有し、チャットやメールに直接貼り付けないようにします。

## Supabase 接続モジュール
Phase 1 で追加された `app/db/client.py` は psycopg のコネクションプールをラップし、サービスロールキーと Anon/User API キーをモードで切り替えます。CLI からは次のように動作確認できます。

```bash
python -m app.db.client doctor --mode service  # サービスロール (Upsert/Delete 用)
python -m app.db.client doctor --mode user     # Anon/User キー (RLS 適用検索用)
```

リポジトリ層やテストでは `from app.db.client import get_connection` を使うことで、`with get_connection(mode="service") as conn:` のように安全に Supabase/PostgreSQL に接続できます。モードを切り替えるだけで RLS 想定のユーザーモードに切り替えられるため、後続の Phase 2/3 でも追加設定なく再利用できます。
