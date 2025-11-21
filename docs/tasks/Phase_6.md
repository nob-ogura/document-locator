# フェーズ6 クローラー CLI 実装 - タスク一覧

> 前提: フェーズ1–5の基盤・ラッパー・モックが揃っていること。実鍵利用は「実鍵・実環境利用計画」に従い、フェーズ6後半で少件数スモークを行う。

### 実行例
- 推奨: `pnpm crawler --mode diff -l 5`
- 誤って `pnpm crawler -- --mode diff -l 5` のようにスクリプト直後に単独の `--` を入れても、CLI 側で先頭の `--` を無視するため同様に実行できる。

### 1. CLI エントリ実装（commander + env デフォルト）
- `crawler --mode [auto|full|diff] --limit <n>` を実装し、未指定時は `CRAWLER_MODE` を採用、指定時は上書き。
- 環境変数必須チェック（Design.md/Plan.md 準拠）、欠落時はエラー終了。
- Gherkin:
```gherkin
Scenario: 環境デフォルトを用いて mode と limit を受け付ける
  Given CRAWLER_MODE に "diff" が設定されている
  And mode オプションなしで "pnpm crawler" を実行する
  Then プロセスは mode を "diff" と解釈する
  When "pnpm crawler --mode full --limit 2" を実行する
  Then プロセスは mode を "full" と解釈する
  And limit は整数 2 としてパースされる
  And 必須環境変数が欠落していれば終了コード 1 とエラーメッセージで終了する
```

### 2. モード判定と sync state 取得
- `drive_sync_state` を読み、auto: レコード無しなら full、ありなら diff。
- フル/差分で処理対象クエリを切り替える。
- Gherkin:
```gherkin
Scenario: mode 判定に drive_sync_state を用いる
  Given drive_sync_state が空である
  And CLI mode が "auto" である
  When crawler を起動する
  Then フルスキャンを選択する
  Given drive_sync_state.drive_modified_at が "2024-10-01T00:00:00Z" である
  And CLI mode が "auto" である
  When crawler を起動する
  Then "modifiedTime > \"2024-10-01T00:00:00Z\"" で差分スキャンを選択する
```

### 3. Drive 列挙・フィルタ・limit 適用
- ターゲットフォルダ存在確認後、`files.list` で全件/差分を取得し、`--limit` で上限。
- 非テキスト MIME は早期スキップ対象にマーク。
- Gherkin:
```gherkin
Scenario: Drive の列挙が mode と limit を尊重する
  Given mode が "diff" で last sync が "2024-10-01T00:00:00Z"
  When crawler が Drive をクエリする
  Then リクエストフィルタに "modifiedTime > '2024-10-01T00:00:00Z'" が含まれる
  And 非テキスト MIME はスキップ対象としてフラグされる
  And limit が 5 のとき処理されるのは最初の 5 件の対象ファイルのみ
```

### 4. テキスト抽出ルート実装
- Google Doc は `files.export(text/plain)`、PDF は `files.get`+`pdf-parse`、それ以外はスキップログ。
- 抽出失敗は警告で継続。
- Gherkin:
```gherkin
Scenario: MIME タイプごとのテキスト抽出
  Given Google Doc ファイル id "doc1" と PDF ファイル id "pdf1" がある
  When crawler がファイルを処理する
  Then "doc1" には mimeType text/plain で files.export を呼び出す
  And "pdf1" には files.get を呼び出し pdf-parse でパースする
  And image/png ではスキップをログし例外を投げずに続行する
```

### 5. AI 処理パイプライン（要約・キーワード・embedding）
- GPT-4o mini で要約・キーワード（3–5）生成後、`summary + keywords + file_name` を text-embedding-3-small に渡す。
- `SUMMARY_MAX_LENGTH` でトランケート。リトライは共通バックオフを利用。
- Gherkin:
```gherkin
Scenario: AI パイプラインが要約・キーワード・Embedding を生成する
  Given SUMMARY_MAX_LENGTH より長い抽出テキストがある
  When crawler が AI パイプラインを呼び出す
  Then 要約は SUMMARY_MAX_LENGTH 文字に切り詰められる
  And キーワード配列は 3〜5 件を含む
  And embedding は text-embedding-3-small でファイルごとに 1 回要求される
  And 429 または 5xx のレスポンス時にリトライポリシーが適用される
```

### 6. Supabase Upsert と sync state 更新
- `drive_file_index` に upsert（summary/keywords/embedding/mime/modifiedTime）。処理最大 modifiedTime を `drive_sync_state` に保存。
- 部分失敗はログに残し、致命的エラーは非0終了。
- Gherkin:
```gherkin
Scenario: Upsert と sync state の更新
  Given modifiedTime を持つ 3 つの処理済みファイルがある
  When すべての upsert が成功する
  Then drive_file_index に 3 レコードすべてが存在する
  And drive_sync_state.drive_modified_at は最大の modifiedTime と等しい
  When 1 件の upsert が失敗する
  Then file_id を含むエラーログを出力する
  And プロセスは非ゼロ終了コードで終了する
```

### 7. 並列実行・バックオフ制御
- 最大並列5でファイル処理。Drive/OpenAI 429/5xx 時は指数バックオフ（1s→2s→4s→8s→16s 最大5回）。
- Gherkin:
```gherkin
Scenario: 並列処理とバックオフ
  Given 処理対象のファイルが 10 件ある
  When crawler が実行される
  Then 同時に処理されるのは最大 5 件である
  And HTTP 429 を受け取った場合、指数バックオフで最大 5 回までリトライする
```

### 8. ログと終了コード
- INFO で取得件数/スキップ/Upsert 件数/失敗件数をサマリ表示。DEBUG でトークン使用量とリトライ詳細。
- 正常終了: 0、致命エラー: 非0。
- Gherkin:
```gherkin
Scenario: ログと終了コード
  Given crawler が processed=8, skipped=2, fatal errors=0 で完了する
  Then INFO ログに "processed=8 skipped=2 upserted=8" が含まれる
  And 終了コードは 0 である
  When 完了前に致命的エラーが発生する
  Then 終了コードは非ゼロである
```

### 9. モック e2e テストと CLI 動作検証
- Vitest で差分/フル分岐、limit、スキップ挙動をモック e2e でカバー。`pnpm lint` / `pnpm test` パスを確認。
- Gherkin:
```gherkin
Scenario: モック e2e で full/diff をカバーする
  Given モックの Drive/OpenAI/Supabase クライアントがある
  When full モードで crawler を実行する
  Then モックファイルがすべて処理される
  When last sync を設定して diff モードで実行する
  Then 新しいモックファイルのみが処理される
  And pnpm test でテストが通過する
```

### 10. 実鍵スモーク（フェーズ6後半・少件数）
- 実鍵を用い、検証用サブフォルダ + `--limit` で小規模通し。token/呼出回数を DEBUG ログで記録。ivfflat 作成・同期更新まで確認。
- Gherkin:
```gherkin
Scenario: 実鍵スモーク（限定スコープ）
  Given .env.production に有効な Drive/OpenAI/Supabase の鍵がある
  And doc, pdf, image を含むスモーク用フォルダがある
  When "pnpm crawler --mode diff --limit 5" をそのフォルダに対して実行する
  Then doc と pdf のテキストがインデックス化され upsert される
  And image ファイルはスキップとしてログされる
  And drive_sync_state が最新の modifiedTime で更新される
  And API 呼び出し回数とトークン使用量が DEBUG ログに出力される
```
