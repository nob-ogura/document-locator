# フェーズ5: OpenAI ラッパー（要約/キーワード/embedding） — タスクと受入基準

## タスク一覧
- T1: OpenAI クライアントラッパー整備（環境変数検証、gpt-4o-mini/embedding 共通設定、共通バックオフ連携、トークン使用量ログ出力）
- T2: 要約生成ユーティリティ実装（SUMMARY_MAX_LENGTH 準拠の二重制限 + 文字数トランケート、temperature=0 / max_tokens 低設定）
- T3: キーワード抽出ユーティリティ実装（JSON 配列 3–5 件を保証し、非 JSON 出力を自動補正するパーサ付き）
- T4: Embedding 生成ユーティリティ実装（text-embedding-3-small 1536 次元、summary+keywords+file_name 連結入力と型ガード）
- T5: 実鍵・実環境スモークとモック切替手順整備（CI は常にモック、手動 1 回のみ実鍵スモークを実施するランブック）

## 受入基準（Gherkin）

### T1: OpenAI クライアントラッパー整備
```
Scenario: 必須環境変数で OpenAI クライアントを初期化し共通バックオフを適用できる
  Given .env に OPENAI_API_KEY が設定され OPENAI_ORG は任意である
  And 共通の retry/backoff ポリシーが util 層に実装されている
  When createOpenAIClient() を呼び出し chat と embeddings の両クライアントを取得する
  Then chat は model="gpt-4o-mini" をデフォルトに temperature=0, max_tokens が低めに設定されている
  And embeddings は model="text-embedding-3-small" をデフォルトにする
  And 429/5xx 応答時に共通バックオフが 1s→2s→4s→8s→16s で最大5回適用される
  And DEBUG ログにリクエスト/レスポンスの token 使用量が出力される

Scenario: 必須環境変数欠落時に安全に失敗する
  Given OPENAI_API_KEY が未設定の状態で createOpenAIClient() を呼ぶ
  Then 関数は例外を投げ、欠落している環境変数名をエラーメッセージに含める
```

### T2: 要約生成ユーティリティ
```
Scenario: 長文を SUMMARY_MAX_LENGTH 以内で要約できる
  Given SUMMARY_MAX_LENGTH=400 が設定され 1000 文字の入力テキストがある
  When summarizeText(input) を呼び出す
  Then OpenAI chat API には model="gpt-4o-mini", temperature=0, max_tokens<=200 でリクエストする
  And 戻り値の文字数が 400 文字以下になるよう末尾トランケートされる
  And 429/5xx 応答時に共通バックオフが適用される
```

### T3: キーワード抽出ユーティリティ
```
Scenario: LLM 出力を JSON 配列 3〜5 件に正規化する
  Given extractKeywords(input) を実行し OpenAI から 'Keywords: foo, bar, baz' が返るモックを用意する
  When 関数が出力をパースする
  Then 戻り値は ["foo","bar","baz"] のような JSON 配列になり、長さは 3〜5 件に収まる
  And model="gpt-4o-mini", temperature=0, max_tokens<=200 で呼び出される
  And JSON でないレスポンスでも補正して配列を返し、失敗時は例外を投げる
```

### T4: Embedding 生成ユーティリティ
```
Scenario: summary+keywords+file_name を連結して 1536 次元のベクトルを得る
  Given file_name="report.pdf" summary="short" keywords=["foo","bar"] を入力する
  When buildEmbeddingInput(...) で文字列を連結し generateEmbedding() を実行する
  Then OpenAI embeddings API が model="text-embedding-3-small" で呼ばれる
  And 戻り値の embedding 長さが 1536 であり、type guard で不足や過剰次元は例外になる
  And 429/5xx 応答時に共通バックオフが適用される
```

### T5: 実鍵・実環境スモークとモック切替手順
```
Scenario: 実鍵スモークを手動 1 回だけ実行し結果をログに残す
  Given .env.production に OPENAI_API_KEY が設定され CI 環境変数が false である
  And Drive API へのコールは禁止されているモック環境である
  When 開発者が `pnpm dlx tsx scripts/smoke-openai.ts --env=.env.production` を手動で実行する
  Then summarizeText / extractKeywords / generateEmbedding が各 1 回成功し非空レスポンスを返す
  And DEBUG ログに token 使用量が記録される
  And スクリプトは 0 で終了し 429/5xx 時は共通バックオフが動作したことを確認できる

Scenario: CI では常にモックに切り替わる
  Given CI=true が設定された環境で summarizeText を呼び出す
  Then OpenAI への実リクエストは送られずモックレスポンスが返る
  And 実鍵なしでもテストが通り、実行ログに "mock openai" など明示的な文言が含まれる

補足: 手動スモークおよびモック切替の実行手順は `docs/runbooks/openai-smoke.md` を参照。
```
