
# Phase 0 タスク (基盤整備)

Phase 0 は Day 0-1 で gdrive-indexer/search の足場を固め、以降の開発を安全に進めることがゴール。以下では docs/Plan.md の Phase 0 要素をタスク化し、成果物と受入基準を明確化する。

## タスクリスト概要

| ID   | タスク名                                      | 目的/主要成果物                                              |
| ---- | --------------------------------------------- | ------------------------------------------------------------ |
| T0-1 | Python実行基盤・パッケージ管理・Lint整備      | pyproject、依存管理、ruff/black/mypy/pytest の実行環境       |
| T0-2 | 設定/秘密情報の読み込みヘルパー実装           | `.env.sample`、configローダー、NFR-SEC-02 準拠の設定設計     |
| T0-3 | CLIエントリーポイントとロギング共通モジュール | `gdrive-indexer` / `gdrive-search` CLI スケルトン + ログ基盤 |
| T0-4 | CIパイプライン (lint/test)                    | GitHub Actions 等で lint+unit test を自動実行                |

## タスク詳細

### T0-1: Python実行基盤・パッケージ管理・Lint整備
- **作業内容**
  - Python 3.13 系を明示して uv を採用し、`pyproject.toml` とロックファイルを生成。
  - 共通ディレクトリ構造(`app/`, `tests/`, `scripts/` など)を作成し、`gdrive_indexer`/`gdrive_search` パッケージを import できるようにする。
  - 開発依存に `ruff`, `black`, `mypy`, `pytest` を追加し、`pyproject.toml` で設定 (target version, line length 等)。
  - `make lint`, `make format`, `make typecheck`, `make test` などローカル実行コマンドを `Makefile` もしくは `uv run` スクリプトで提供。
- **受入基準**
  - `uv sync` で依存が再現可能。
  - `ruff check`, `black --check`, `mypy`, `pytest` が素のリポジトリで成功する。
  - README にセットアップ手順が追記され、オンボーディングが 15 分以内で終わる情報が揃う。

### T0-2: 設定/秘密情報の読み込みヘルパー実装
- **作業内容**
  - `.env.sample` を作成し、必要な環境変数 (Google API 認証情報、OpenAI API Key、Supabase URL/Key など) を定義。
  - `app/config/__init__.py` に `.env` と `~/.config/document_locator/config.toml` (Plan 記述の `~/.config/.../config.toml`) を読み込むヘルパーを実装。優先順位: 環境変数 > 個人設定ファイル > `.env`。
  - 型付け構成 (pydantic BaseModel など) でセクション毎に設定を表現し、CLI から簡単に import できる API を提供。
  - NFR-SEC-02 に沿って、コード内に秘密値を直書きせず、`.env` にはコメントとサンプル値のみを記載。
- **受入基準**
  - `python -m app.config doctor` のような簡易コマンドで設定が解決できているか検証できる。
  - `.env` を空のままコミットしても、ユーザーが `.env.sample` をコピーして埋めるだけで最低限の CLI が動く。
  - 構成値が存在しない場合にわかりやすい例外/ログが得られる (Plan 3. Phase0 bullet)。

### T0-3: CLIエントリーポイント + ロギングモジュール
- **作業内容**
  - `app/cli/indexer.py` と `app/cli/search.py` (もしくは同等の構成) を作り、`pyproject.toml` の `project.scripts` に `gdrive-indexer`, `gdrive-search` を登録。
  - 各 CLI は Phase 1+2 の実装場所となる関数をスタブ化 (`def run(args): ...`) し、`argparse` で `--log-level`, `--config` など基本オプションを受け付ける。
  - `app/logging.py` に共通の構造化ログ設定を実装し、JSON/プレーンテキスト切替、ログレベル、stdout/stderr の振り分けを制御できるようにする。
  - CLI 実行時に logging 初期化と設定読込を行うテンプレートコードを配置し、後続 Phase でロジックを差し込める状態にする。
- **受入基準**
  - `gdrive-indexer --help`, `gdrive-search --help` が成功し、想定オプションが表示される。
  - どちらかの CLI を `--log-format=json` 等で呼ぶと、共通ロギング設定が効いたログ1行が出力される。
  - コードベースに CLI の単体テスト (引数パースレベルで可) が追加され、CI で実行される。

### T0-4: CIパイプライン整備
- **作業内容**
  - GitHub Actions (例: `.github/workflows/ci.yml`) を追加し、`python -m pip install uv` → 依存解決 → `ruff`, `black --check`, `mypy`, `pytest` を並列または段階的に実行。
  - キャッシュ戦略 (uv、`.venv`、`.mypy_cache`) を設定して 5 分以内にワークフローが完走するよう調整。
  - main ブランチ push と Pull Request で CI が走るようトリガーを設定し、最小限のバッジや README 記載を追加。
- **受入基準**
  - PR 作成時に自動で lint/test が実行され、fail するとマージできない状態を確認。
  - CI ログで Python バージョン 3.13 系が用いられていること、`ruff/black/mypy/pytest` がレポートを出力していることを確認できる。
