# Phase 2 タスク (クローラーCLI `gdrive-indexer`)

Phase 2 は Day 2-5 に `gdrive-indexer` を完成させ、共有ドライブ差分クロール→要約/埋め込み生成→Supabase 同期までを一気通貫で動かすことがゴール。docs/Plan.md の Phase 2 項目をタスク化し、前後依存と成果物を整理する。

## タスクリスト概要

| ID   | タスク名                                      | 目的/主要成果物                                                                                  |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| T2-1 | Drive 検出と Crawler State 制御               | `drives.list` ベースのターゲット列挙、`crawler_state` CRUD、フル/デルタ実行モードのCLI引数        |
| T2-2 | 差分ポーリング & Drive API クライアント基盤  | `changes` API ラッパー、共有ドライブ対応フラグ、レート制御/リトライ機構                         |
| T2-3 | コンテンツ抽出パイプライン                    | MIME種別ごとの抽出実装 (Docs/Slides/Sheets/PDF 等)、失敗スキップのロギング                      |
| T2-4 | AIメタデータ生成ラッパー                      | GPT-4o mini 呼び出し + スキーマ検証 + リトライ/フォールバック                                   |
| T2-5 | ベクトル化とキャッシュ                        | `text-embedding-3-small` クライアント、入力整形、任意の埋め込みキャッシュ                       |
| T2-6 | インデックス同期と削除フロー                  | Upsert/論理削除呼び出し、トランザクション制御、`crawler_state` 更新                             |
| T2-7 | オブザーバビリティとコスト計測                | 構造化ログ/Metrics/Middleware で Drive/OpenAI 呼び出しコストと失敗数を可視化                    |
| T2-8 | モック統合テスト                              | Drive/OpenAI クライアントをモック化した差分→DB同期の統合テストシナリオ                          |

## タスク詳細

### T2-1: Drive 検出と Crawler State 制御
- **作業内容**
  - `gdrive-indexer` の CLI 引数に `--mode={full,delta}`, `--drive-id`, `--dry-run` 等を追加し、Phase 1 の repository/API を注入できる実行ループを実装。
  - Google Drive API の `drives.list` (共有ドライブ) と `about.get` (マイドライブ) を使って対象ドライブを列挙し、Plan 記載の Design 4.1-1,6 に沿って `crawler_state` に初期レコードを作成/更新する。
  - `crawler_state` が存在しないドライブは初回フルクロール、`start_page_token` がある場合はデルタクロールを選択するロジックを定義。
  - CLI 起動時に各ドライブ単位で処理ループを回すタスクスケジューラ (同期/並列) を整備し、失敗ドライブも他へ影響しないよう try/except で分離。
- **受入基準**
  - `gdrive-indexer --mode delta` 実行時に、未登録ドライブは自動で `crawler_state` が挿入され、ログで初期トークン取得が確認できる。
  - `--drive-id=xxx` 指定時にそのドライブのみ処理され、CLI 終了コードが各ドライブの success/failure に準拠する。

### T2-2: 差分ポーリング & Drive API クライアント基盤
- **作業内容**
  - `app/drive/client.py` (仮) に `changes.getStartPageToken`, `changes.list`, `files.get`, `files.export` 等の API 呼び出しラッパーを実装し、Plan の「supportsAllDrives/includeItemsFromAllDrives を常時付与」をデフォルトパラメータ化。
  - レート制御: HTTP 429, 403 + `reason=userRateLimitExceeded|rateLimitExceeded` を検出し、`Retry-After` 優先待機→指数バックオフ + ジッター (最大3回) を実装。待機/再試行をログに可視化。
  - 差分ポーリングループで `changes.list` のページングと `newStartPageToken` の扱いを抽象化し、Plan Step 3 フロー通りにイベントをストリーミング。
  - API エラー時のリトライと致命的エラーの分類 (認証/権限/404) を定義し、再実行時に同じイベントから再開できるようチェックポイント (last processed change id) を保持。
- **受入基準**
  - 単体テストで 429/403 レスポンスをシミュレートし、`Retry-After` と指数バックオフ経路が期待通りに動く。
  - shared drive のファイルを含む changes を取得した際、`supportsAllDrives/includeItemsFromAllDrives` が必ずつくことをログまたはテストで検証できる。

### T2-3: コンテンツ抽出パイプライン
- **作業内容**
  - MIME 種別ごとの extractor 実装 (`Google Docs -> files.export(text/plain)`, `Slides -> text/plain`, `Sheets -> CSV`, `PDF -> pdfminer` など) を Strategy パターンで整理。
  - バイナリ取得時のサイズ上限/ページ数制限を設定ファイルから制御し、過大ファイルは WARNING を出してスキップ。
  - 抽出結果を正規化 (`title`, `body`, `last_modified`, `owners` 等) し、後続の要約/埋め込みに渡すデータクラスを定義。
  - 失敗時は例外を握りつぶさず構造化 WARNING を記録し、再実行用に `failed_items` を集計。
- **受入基準**
  - 代表的 MIME (Docs, Slides, Sheets, PDF, image) で extractor が Route される unit test が存在。
  - 失敗ファイルがあっても CLI が継続し、ログに `skipped_reason` が出力される。

### T2-4: AIメタデータ生成ラッパー
- **作業内容**
  - GPT-4o mini 用の OpenAI 呼び出しモジュールを作り、入力プロンプト (title/context/抽出本文) と期待スキーマ (summary, keywords[]) を JSON Schema で検証。
  - エラー/Timeout 時は Plan 記載通り 3 回までリトライし、それでも失敗した場合は空 summary/keywords を返しつつ WARNING。
  - 設定ファイルからモデル名/温度/最大 tokens/プロンプトテンプレートを差し替え可能にし、Plan リスク緩和 (要約品質調整) に対応。
  - 生成ログにトークン使用量を記録し、後続のメトリクス (T2-7) に統合。
- **受入基準**
  - OpenAI API をモックしたユニットテストで、失敗→リトライ→フォールバックのフローが検証される。
  - 成功時は summary/keywords が型安全なデータクラスで返却され、後続処理でパース不要。

### T2-5: ベクトル化とキャッシュ
- **作業内容**
  - `text-embedding-3-small` クライアントラッパーを実装し、入力文字列は `title + summary + keywords` を結合して 8k tokens 以内にトリミング。
  - 任意のローカルキャッシュ (SQLite/ファイル) をオプションで提供し、同一ハッシュの入力に対して埋め込み API 呼び出しをスキップ。
  - 失敗時のリトライ戦略は AI メタデータと共通のバックオフロジックを採用し、Plan Step 6 の要件を満たす。
  - 生成した埋め込みを Repository が期待する長さ (1536) で検証し、不整合時に例外を出す。
- **受入基準**
  - キャッシュを有効化した状態で同一ファイルを再処理すると OpenAI 呼び出しが 1 回で済むことをログで確認できる。
  - 埋め込み結果が NumPy/リスト等のシリアライズ可能形式で返却され、DB Upsert で直接利用可能。

### T2-6: インデックス同期と削除フロー
- **作業内容**
  - 差分イベントを `FileIndexRepository.upsert_files()` / `mark_deleted()` にバッチで渡し、成功時のみ `crawler_state.start_page_token` を更新するトランザクション制御を実装 (Design 4.1-6,7)。
  - 論理削除イベント (removed=true, file remains) を正しく判定し、`deleted_at` を更新。ファイル復活時は `deleted_at` を null に戻す。
  - Supabase へのバッチ送信サイズと間隔を設定値でチューニングし、大量イベント時も OOM しないようストリーム処理を行う。
  - `gdrive-indexer` の終了ログに upsert 件数 / delete 件数 / 失敗件数 / 所要時間を出力。
- **受入基準**
  - モック差分を流し込む統合テストで、Add/Update/Delete イベントを処理し、`crawler_state` が最後の `newStartPageToken` に更新される。
  - 途中で例外が起きた場合は `crawler_state` が更新されず、次回再実行で未処理イベントから再開できる。

### T2-7: オブザーバビリティとコスト計測
- **作業内容**
  - Phase 0 の logging モジュールにカウンタ/タイマー付きの middleware を追加し、Drive API と OpenAI API の呼び出し毎に `cost.usd_estimate`, `latency_ms`, `status` を構造化ログへ記録。
  - CLI の終了時に `processed_files`, `skipped_files`, `api_calls.drive`, `api_calls.openai`, `estimated_cost_usd` をまとめたメトリクス行を INFO 出力。
  - Option で JSON Lines をファイルに書き出し、将来の監視に利用できるよう `--metrics-output` フラグを実装。
- **受入基準**
  - ローカル実行でログを解析すると、Drive/OpenAI 呼び出し数と失敗数が確認できる。
  - `--metrics-output=./metrics.jsonl` 指定時にファイルへ追記され、再実行すると追記モードで壊れない。

### T2-8: モック統合テスト
- **作業内容**
  - Drive/OpenAI クライアントのモック実装を用意し、差分イベント→コンテンツ抽出→AIメタデータ→埋め込み→DB upsert までを pytest で再現。
  - 異常系 (Rate limit, OpenAI 失敗, Upsert 失敗) を組み込んだシナリオを複数テーブル駆動テストで表現。
  - テストデータを `tests/fixtures/drive_changes.json` 等で管理し、Plan Design 9 の KPI 対応 (処理件数/失敗件数がログ出力される) を検証。
- **受入基準**
  - `pytest tests/indexer` が CI 上でも安定して動き、API 呼び出しを実際には行わない。
  - テスト失敗時に原因ドライブ/ファイル/イベント ID がログと Assertion メッセージから判別できる。
