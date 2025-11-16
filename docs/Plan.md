# 実装計画 (Step 1 MVP)

## 1. 目的
- `docs/Design.md` で示されたクロール/検索の2フローを、PoC要件（FR-C/S、NFR、KPI）を満たす形で実装・運用できるように段階的な作業計画を定義する。
- 成果物: Pythonベースの `gdrive-indexer`/`gdrive-search` CLI、Supabase(pgvector) スキーマ、監視・テストの仕組み。

## 2. 前提・スコープ
- 言語はPython 3.13系、CLIは `app/crawler`, `app/search` 構成案に従う。
- 外部サービス: Google Drive API, OpenAI API, Supabase(PostgreSQL + pgvector)。
- MVPでは `.env` の `GOOGLE_DRIVE_TARGET_FOLDER_ID` で指定した単一フォルダの配下のみをクロール/検索対象とし、その他の共有ドライブやマイドライブは非スコープ。ハイブリッド検索やWeb UIも非スコープ。

## 3. 実装フェーズ

### Phase 0: 基盤整備 (Day 0-1)
- Poetry/uv などのパッケージ管理と lint/format (ruff, black, mypy) を設定。
- `.env.sample` と `~/.config/.../config.toml` 読み込みヘルパーを用意し、秘密情報は環境変数経由に限定 (NFR-SEC-02)。
- CLIエントリーポイント (`gdrive-indexer`, `gdrive-search`) のスケルトンとロギング共通モジュールを作成。
- GitHub Actions 等で lint + 単体テストを回すCIを用意。

### Phase 1: DB/永続化レイヤー (Day 1-2)
- Supabase接続モジュールと `db/repositories.py` を実装。接続はサービスアカウントキー/ユーザーAPIキーで切り替え可能にする。
- マイグレーション `app/db/migrations/0001_init.sql`:
  - `file_index(file_id PK, drive_id, file_name, summary, keywords, embedding vector(1536), mime_type, last_modifier, updated_at, deleted_at)` に pgvectorインデックス。
  - `crawler_state(drive_id PK, start_page_token, last_run_at, last_status)`。
- repositoryテスト: Upsert/検索/削除。

### Phase 2: クローラーCLI (`gdrive-indexer`) (Day 2-5)

- **ターゲットフォルダ検証/状態管理** (Design 4.1-1,6): `.env` の `GOOGLE_DRIVE_TARGET_FOLDER_ID` を読み込み `files.get` で存在確認→ `crawler_state` CRUD。フォルダ単位でフル/デルタモードを切り替え、単一フォルダの状態管理に特化した実行ループを用意。
- **差分ポーリング** (4.1-2, Step 3フロー):
  - Google Drive APIクライアントラッパーを実装し、`changes.getStartPageToken`, `changes.list` などの呼び出しを抽象化する。
  - **堅牢なレート制御とリトライ戦略:**
    - **HTTP `429 (Too Many Requests)`** に加え、**HTTP `403 (Forbidden)`** であり、かつレスポンスボディのエラー理由 (`reason`) が `userRateLimitExceeded` または `rateLimitExceeded` である場合を、レート制限エラーとして適切にハンドリングする。
    - APIレスポンスに **`Retry-After` ヘッダー**が含まれる場合は、その指示された秒数を最優先で待機する。
    - `Retry-After` がない場合は、**ジッター（ランダムな揺らぎ）を加えた指数バックオフ戦略**に基づき再試行（最大3回など）を実施する。
  - **ターゲットフォルダ限定の徹底:**
    - APIクライアントラッパーは、`files` や `changes` API群の呼び出し時に **`supportsAllDrives=true`** / **`includeItemsFromAllDrives=true`** を常時付与しつつ、`changes.list` 後には `parents` 情報で `GOOGLE_DRIVE_TARGET_FOLDER_ID` 配下のみをフィルタする。
- **コンテンツ抽出** (4.1-3, Step 4): MIME種別ごとに抽出戦略を実装。Google Docs/Slides/Sheetsの `files.export`, バイナリ(PDF)のtext抽出。失敗時は WARNING とスキップログ。
- **AIメタデータ生成** (4.1-4, Step 5): GPT-4o mini 呼び出しラッパー、レスポンススキーマ検証、3回までのリトライと代替出力 (空summary)。
- **ベクトル化** (4.1-5, Step 6): `text-embedding-3-small` クライアントと埋め込みキャッシュ（オプション）。入力は `title + summary + keywords`。
- **インデックス同期/削除** (4.1-6 + Step 7): `repositories.upsert_files()` で複数行Upsert、削除イベント処理。コミット成功後のみ `crawler_state` 更新 (4.1-7, Step 8)。
- **オブザーバビリティ**: 処理件数/失敗件数/API呼び出しコストを構造化ログに記録 (Design 8)。OpenAI/Drive呼び出しを計測するミドルウェアを導入。
- **テスト**: Drive/OpenAIクライアントをモックし、差分イベント→DB更新までの統合テスト (Design 9)。

### Phase 3: 検索CLI (`gdrive-search`) (Day 5-7)
- **OAuth & 権限フィルタ** (Design 4.2, 7): ユーザートークン取得、macOS/Linuxの秘密ストア連携。`files.list (q="'${GOOGLE_DRIVE_TARGET_FOLDER_ID}' in parents")` でターゲットフォルダ内の閲覧可能 `file_id` を集約し、空集合時はエラー。
- **クエリ処理** (Design 5.2 Step 1-4): クエリバリデーション、embedding生成、Supabase RPCで `topk` ベクトル検索を実行。
- **結果表示**: テキスト/JSON出力オプション、distanceとDriveリンクの表示 (Design 5.2 Step 5)。
- **ユーザーログ**: 実行時ユーザー識別子、クエリ長のみをINFOログに記録 (Design 7)。
- **テスト**: モックOAuthトークンでA/Bユーザーが互いに他者ファイルを取得しないことを確認 (Design 9 KPI-1)。

### Phase 4: 運用・テスト・仕上げ (Day 7-9)
- **E2Eスクリプト**: `.env` で設定したターゲットフォルダ内で作成/更新/削除→クローラー→検索の流れを再現し、結果CSVを出力 (Design 9)。
- **メトリクス/ローテーション**: CLI終了コードとログから Slack/メール通知へ渡すスクリプト、APIコール数の集計。
- **ドキュメント**: README更新、CLI使用例、設定ファイルテンプレート、トラブルシュート、APIコスト見積もり。
- **リリース準備**: cron/ワークフローの設定例、環境変数一覧、PoC評価手順書を添付。

## 4. マイルストーンと出口基準
- **MS1 (Day 2)**: DBスキーマとリポジトリ層のテストが通り、`Plan` に沿ったCI基盤が稼働。
- **MS2 (Day 5)**: `gdrive-indexer --mode=delta` がモック環境で差分同期を完了し、ログで処理件数とAPIコストが出力される。
- **MS3 (Day 7)**: `gdrive-search` が権限フィルタ付きで実ベクトル検索を返却し、A/Bユーザーテスト合格。
- **MS4 (Day 9)**: E2Eテスト・監視・ドキュメントが整い、PoC KPI-1〜3を検証するデータ取得手段が用意されている。

## 5. リスク緩和アクション
- Drive APIクォータ逼迫に備え、Phase 2でAPI呼び出し数をログ出力し、閾値超過時のレートリミット設定を構成ファイル化。
- 要約品質問題に備え、メタデータ生成ラッパーでプロンプト/トークンを設定ファイルから変更可能にし、失敗時は要約無しでも検索継続できるよう設計。
