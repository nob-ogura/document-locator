# フェーズ2: 共通基盤（env/logger/utils/クライアント枠） — タスクと受入基準

## タスク一覧
- T1: 環境変数ローダー＋バリデーション（必須/任意は Design.md 4 章準拠、欠落時は起動時エラー）
- T2: 共通ロガー実装（INFO/DEBUG/ERROR を 1 行出力、LOG_LEVEL でフィルタ）
- T3: 時刻ヘルパー（RFC3339 文字列⇔Date、TZ/UTC 変換、modifiedTime 比較ユーティリティ）
- T4: HTTP リトライ共通化（429/5xx への指数バックオフ 1→2→4→8→16s、最大 5 回。ロガー連携）
- T5: 外部クライアント枠（Google Drive / OpenAI / Supabase）のファクトリと設定注入（実 API 呼び出しは後続フェーズで実装）

## 受入基準（Gherkin）

### T1: 環境変数ローダー＋バリデーション
```
Scenario: 必須の環境変数が揃っているときに構成を取得できる
  Given .env に Design.md 4.1 の必須キーが全て定義されている
  When 開発者が loadEnv() を呼び出す
  Then 戻り値に全ての必須キーが型付きで含まれる
  And LOG_LEVEL が未指定なら "info" が設定される

Scenario: 必須の環境変数が欠落しているときに起動が失敗する
  Given .env から SUPABASE_SERVICE_ROLE_KEY を削除した状態で loadEnv() を呼び出す
  Then 関数は例外を投げ、欠落キー名がメッセージに含まれる
```

### T2: 共通ロガー（INFO/DEBUG/ERROR）
```
Scenario: INFO ログが 1 行で出力される
  Given LOG_LEVEL が "info" に設定されている
  When logger.info("crawler started", { files: 10 }) を呼び出す
  Then 出力が改行 1 回のみで、メッセージとコンテキストが JSON 形式で含まれる

Scenario: DEBUG ログがフィルタされる
  Given LOG_LEVEL が "info" に設定されている
  When logger.debug("verbose detail") を呼び出す
  Then 何も出力されない
```

### T3: 時刻ヘルパー（RFC3339 / TZ 変換 / 比較）
```
Scenario: RFC3339 文字列を Date に変換して元に戻せる
  Given "2024-09-01T10:00:00Z" を toDate() に渡す
  When 返却値を toRFC3339() に再度渡す
  Then 同じ文字列 "2024-09-01T10:00:00Z" が得られる

Scenario: modifiedTime 比較ヘルパーが新旧を判定できる
  Given earlier = "2024-09-01T09:00:00Z" と later = "2024-09-01T10:00:00Z"
  When isAfter(later, earlier) を評価する
  Then true が返る
  And isAfter(earlier, later) は false を返す
```

### T4: HTTP リトライ共通化
```
Scenario: 429 応答を指数バックオフで再試行する
  Given fetchWithRetry が初回 429, 2 回目 500, 3 回目 200 を返すモック fetch を受け取る
  When fetchWithRetry を実行する
  Then 合計 3 回リクエストが行われる
  And 待機時間は 1 秒 + 2 秒 （合計 3 秒±誤差）となる
  And 最終結果は 200 応答として返される

Scenario: 4xx（429 以外）でリトライせずに失敗する
  Given 初回で 400 を返すモック fetch を渡す
  When fetchWithRetry を実行する
  Then リトライせずに例外がスローされる
```

### T5: 外部クライアント枠のファクトリ
```
Scenario: 環境設定でクライアントを生成できる
  Given loadEnv() で得た設定オブジェクトを持っている
  When createGoogleDriveClient(config), createOpenAIClient(config), createSupabaseClient(config) を呼び出す
  Then それぞれ認証情報を保持したクライアントインスタンスが返る
  And これらのファクトリは外部 API を即時に呼び出さない
  And 返却値は logger を内部で共有し、共通リトライポリシーを利用する
```
