# フェーズ 1: 開発環境と基盤コードの整備 (P0)

※ 前提: 実装するコードは TypeScript を使用する。

## タスク一覧

- T1: CLI アプリケーション構成の雛形を作成する（エントリーポイント、`crawl` / `search` サブコマンドのスケルトンを含む）
- T2: `docs/Concept.md` / `docs/Requirements.md` に沿って `README.md` にプロジェクト概要と CLI 利用方法の骨子を追記する
- T3: `.env` ローダーモジュールを実装し、`GOOGLE_DRIVE_TARGET_FOLDER_ID` と LLM / Embedding / Supabase / `felores/gdrive-mcp-server` の接続情報を読み込めるようにする
- T4: 必須環境変数が不足している場合に起動を失敗させるバリデーションを実装する
- T5: ログレベル（例: `DEBUG` / `INFO` / `ERROR`）を持つ簡易ロガーを実装する
- T6: クローラー CLI / セマンティック検索 CLI が共通ロガーを利用できるようにする

## 受入基準 (Gherkin)

### T1: CLI アプリケーション構成の雛形

```gherkin
Feature: CLI application skeleton

  Scenario: document-locator コマンドでヘルプを表示できる
    Given Node.js LTS がインストールされている
    And プロジェクトの依存パッケージがインストールされている
    When 開発者が `document-locator --help` を実行する
    Then プロセスが終了コード 0 で終了する
    And 標準出力に "crawl" サブコマンドの説明が含まれている
    And 標準出力に "search" サブコマンドの説明が含まれている
```

### T2: README にコンセプトと利用方法の骨子を記載する

```gherkin
Feature: README basics

  Scenario: README にコンセプトと利用方法の骨子が記載されている
    Given リポジトリルートに `README.md` が存在する
    When 開発者が `README.md` を開く
    Then 文書冒頭に本システムの目的と PoC で検証する価値が日本語で記載されている
    And README に Google Drive クローラー CLI と セマンティック検索 CLI の概要説明がある
    And README に それぞれの CLI の実行例が少なくとも1つずつ載っている
    And README から `docs/Concept.md` と `docs/Requirements.md` への参照リンクが記載されている
```

### T3: `.env` ローダーモジュールの実装

```gherkin
Feature: Environment variable loader

  Scenario: 必須環境変数が定義されている場合に CLI が起動できる
    Given プロジェクトルートに `.env` ファイルが存在する
    And `.env` に `GOOGLE_DRIVE_TARGET_FOLDER_ID` と LLM / Embedding / Supabase / gdrive-mcp-server の接続情報が定義されている
    When 開発者が `document-locator crawl` を実行する
    Then プロセスが終了コード 0 で終了する
    And 標準エラー出力に「必須の環境変数が不足しています」という内容のメッセージが出力されない
```

### T4: 必須環境変数の起動時バリデーション

```gherkin
Feature: Environment variable validation

  Scenario: 必須環境変数が不足している場合に起動に失敗する
    Given `.env` に `GOOGLE_DRIVE_TARGET_FOLDER_ID` が定義されていない
    When 開発者が `document-locator crawl` を実行する
    Then プロセスが非 0 の終了コードで終了する
    And 標準エラー出力に「必須の環境変数が不足しています」という内容のメッセージが出力される
    And エラーログが ERROR レベルで出力される
```

### T5: ログレベル設計と簡易ロガーの実装

```gherkin
Feature: Logging levels

  Scenario: INFO レベルで DEBUG ログが出力されない
    Given `.env` に `LOG_LEVEL=info` が設定されている
    When ログ出力を行う CLI コマンド（例: `document-locator crawl`）を実行し、DEBUG と INFO のログを発生させる
    Then 標準出力に INFO レベルのログメッセージが含まれている
    And 標準出力に DEBUG レベルのログメッセージは含まれていない

  Scenario: ERROR ログが標準エラー出力に出力される
    Given `.env` に `LOG_LEVEL=info` が設定されている
    When CLI が recoverable でないエラーを検知する
    Then 標準エラー出力に ERROR レベルのログメッセージが出力される
    And 各ログ行にタイムスタンプ・ログレベル・メッセージが含まれている
```

### T6: クローラー / 検索 CLI から共通ロガーを利用する

```gherkin
Feature: Shared logger for crawler and search CLI

  Scenario: クローラー CLI と検索 CLI が同じ形式のログを出力する
    Given `.env` に `LOG_LEVEL=info` が設定されている
    When 開発者が `document-locator crawl` を実行して 1 行の INFO ログを発生させる
    And 開発者が `document-locator search "test"` を実行して 1 行の INFO ログを発生させる
    Then 2 つのログ行は同じフォーマット（タイムスタンプ + ログレベル + メッセージ）で出力される
    And 両方の CLI コマンドが同じロガーモジュールを利用していることがコード上で確認できる
```
