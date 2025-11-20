# 実装計画（PoC）

## 前提
- 対象: Google Drive 検索 CLI（`crawler` / `search`）PoC。
- 技術: Node.js 22 + TypeScript 5, pnpm, commander, tsx, Supabase(pgvector), OpenAI GPT-4o mini / text-embedding-3-small。
- OS: macOS 前提。環境変数は `.env` で集中管理、欠落時は起動エラーとする。
- 成果物: CLI 2 本、SQL マイグレーション、テスト、運用ドキュメント。

## フェーズ一覧
1. プロジェクト初期設定
2. 共通基盤（env/logger/utils/クライアント枠）
3. DB スキーマとリポジトリ
4. Google Drive 取得・テキスト抽出基盤
5. OpenAI ラッパー（要約/キーワード/embedding）
6. クローラー CLI 実装
7. セマンティック検索 CLI 実装
8. テスト・検証
9. 運用ドキュメント整備

## フェーズ詳細

### 1. プロジェクト初期設定
- タスク: Node 22 / pnpm 前提のプロジェクト初期化、`tsconfig`、`biome`、`vitest`、`commander`、`tsx` 導入。`src/` 雛形とスクリプト（`pnpm crawler`, `pnpm search`, `pnpm db:apply`, `pnpm test`）を整える。
- DOD: `pnpm lint` / `pnpm test` が通る空プロジェクト、ビルド不要で `pnpm crawler --help` が動く。

### 2. 共通基盤（env/logger/utils/クライアント枠）
- タスク: `.env` ローダー＋バリデーション（必須/任意を Design.md に準拠）、シンプルな logger（INFO/DEBUG/ERROR 1 行出力）、時刻ヘルパー（RFC3339 変換・比較）、HTTP リトライポリシーの共通実装。Google/OpenAI/Supabase クライアント生成の枠を置く。
- DOD: 環境変数欠落で即エラー終了すること、共通ロガーで CLI からメッセージ出力できること。

### 3. DB スキーマとリポジトリ
- タスク: `sql/` に `drive_file_index` / `drive_sync_state` 作成 SQL と Index（BTree, ivfflat 初期値 lists=100, probes=10）。`pnpm db:apply` スクリプト。Supabase JS クライアントラッパーとリポジトリ関数（upsert, select by ids, vector search, sync state 取得/更新）。
- DOD: ローカル環境で SQL を適用できること（dry-run でも可）、Supabase ラッパーが型安全に動くこと。

### 4. Google Drive 取得・テキスト抽出基盤
- タスク: 認証済み Drive クライアント（ターゲットフォルダ限定ユーティリティ）、`files.list` ページング、差分/フル判定ロジック骨格。文書: `files.export(text/plain)`、PDF: `files.get` + `pdf-parse`。非テキスト（画像/zip 等）スキップ。429/5xx バックオフ共通利用。
- DOD: サンプルフォルダで一覧取得と PDF/Doc のテキスト抽出が成功し、非対応 MIME はスキップログを出す。

### 5. OpenAI ラッパー（要約/キーワード/embedding）
- タスク: GPT-4o mini への要約（`SUMMARY_MAX_LENGTH` 準拠でトランケート）、キーワード抽出（JSON 配列 3–5 件）、Embedding 生成（text-embedding-3-small 1536 次元）。呼び出しは温度 0、max_tokens 低め。レートリミット時は共通リトライ利用。デバッグ用に token 使用量ログを残す。
- DOD: モックテストで JSON 形式を保証し、実環境で 1 件問い合わせが成功すること。

### 6. クローラー CLI 実装
- タスク: commander で `crawler --mode [auto|full|diff] --limit <n>`. フル/差分判定（`drive_sync_state`）、Drive 列挙→テキスト抽出→要約/キーワード→embedding→Supabase upsert、最大 modifiedTime を sync state へ保存。非致命エラーは警告で継続、致命エラーは非0終了。並列度最大 5、指数バックオフ適用。
- DOD: モック込みの e2e テストで差分/フルの分岐が通ること、ログに件数サマリが出ること、`--limit` 動作確認。

### 7. セマンティック検索 CLI 実装
- タスク: `search [options] <query>`。オプション: `--after/--before/--mime`. GPT でキーワード 3–5 件抽出 → Drive 検索（ターゲットフォルダ限定） → `drive_file_index` との積集合でヒット件数算出。件数に応じた分岐: 0 件リトライ提案（キーワードが 1 件になっても 0 件なら「見つかりませんでした」で即終了）、1 件即表示、2–10 件 LLM リランキング, 11–100 件 ベクトル検索（上位10件）、101+ 件 追加質問生成ループ。ループ上限 `SEARCH_MAX_LOOP_COUNT`。出力フォーマット例に準拠。
- DOD: 分岐ロジックのユニットテスト（0/1/5/50/120 ケース）、CLI 出力が想定フォーマットで並ぶこと、ループ上限で適切なメッセージを出す。

### 8. テスト・検証
- タスク: vitest で単体テスト（キーワード JSON 形式、分岐ロジック、差分日時比較）、簡易モックによる e2e（小規模フォルダ、画像スキップ、ループ上限）。テストフィクスチャとモックレスポンス整備。
- DOD: `pnpm test` で主要分岐をカバー、失敗時のメッセージ確認、負荷テストは対象外と明記。

### 9. 運用ドキュメント整備
- タスク: `.env` テンプレート例、Cron 設定例（10 分間隔）、トラブルシュート（認可エラー/429/DB 失敗時の対処）を README に追記。Dev 用サンプルコマンド（`pnpm dlx tsx src/crawler.ts` 等）とログ出力例を記載。
- DOD: README 更新でセットアップ～実行までの手順が 1 本でたどれること。

## 実鍵・実環境利用ポリシー
- OpenAI/Drive 実鍵切替
  - フェーズ1–4: すべてモック、キーは読み込まない。
  - フェーズ5開始時: OpenAI のみ 1 回スモーク（要約/キーワード/embedding のレスポンス形状確認）。
  - フェーズ6後半: Drive+OpenAI 実鍵を少件数（`--limit`、検証用サブフォルダ）で流し、crawler 全体を確認。
  - フェーズ7前半: OpenAI 実鍵のみで検索分岐を検証、安定後に Drive 実鍵を当てて少件数で再確認。
  - 環境分離: 開発用 `.env.development` と本番相当 `.env.production` を分け、CI は原則モック。
  - ログ/制御: 実鍵利用時はトークン消費と API 呼出回数を DEBUG で記録し、429/5xx のバックオフ動作を確認。低トラフィック時間帯に実行。

- Supabase 実環境テスト開始タイミング
  - フェーズ3完了直後: `pnpm db:apply` を実環境で一度実行し、接続と権限を早期確認。
  - フェーズ4終盤: ダミー upsert/select でラッパーの型とエラー処理を実データで検証。
  - フェーズ6後半: Drive+OpenAI 少件数 run と併せ、`drive_file_index` upsert と `drive_sync_state` 更新を一連で実測（ivfflat 作成もこのタイミング）。
  - フェーズ7中盤: ベクトル検索パラメータ（k / lists / probes）を実データで 1 回計測し、閾値を微調整。
  - CI 方針: CI はモックのみで Supabase へは接続しない。

## マイルストーン目安
- M1: フェーズ 1–3 完了で基盤 + DB 準備。
- M2: フェーズ 4–6 完了でクローラー PoC 動作。
- M3: フェーズ 7–8 完了で検索 PoC & テスト通過。
- M4: フェーズ 9 完了で運用開始可能。
