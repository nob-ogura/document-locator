# フェーズ8 テスト・検証 — タスクと受入基準

> 前提: フェーズ1–7で実装済みのクロール/検索機能が存在し、実鍵は Plan 記載の手動スモーク手順に従って限定利用する。負荷試験は PoC 対象外であることを明示する。

## タスク一覧
- T1: ユニットテスト整備（キーワード抽出 JSON 正規化、検索分岐ロジック 0/1/5/50/120 ケース、差分クロール日時比較の境界条件）
- T2: モック e2e（小規模フォルダ）でクローラー挙動確認（Doc/PDF 要約生成と非テキスト MIME スキップ、drive_sync_state 更新）
- T3: モック e2e で検索ループ検証（0 件リトライ、1 件即時終了、2–10 件リランキング、11–100 件ベクトル検索、101+ 追加質問とループ上限メッセージ）
- T4: テストフィクスチャ/モックレスポンス整備（Drive/OpenAI/Supabase の段階ごとの期待呼び出しと戻り値を共通化し再利用）
- T5: テスト実行とレポート整備（`pnpm test` のワンコマンド成功、失敗時メッセージ確認手順、負荷試験非対象の注記）

## 受入基準（Gherkin）

### T1: ユニットテスト整備
```gherkin
Scenario: キーワード抽出の出力を JSON 配列 1〜5 件に正規化する
  Given extractKeywords が 'Keywords: foo, bar, baz' を返す OpenAI モックを使用している
  When vitest でキーワードユーティリティのテストを実行する
  Then 戻り値は ["foo","bar","baz"] の JSON 配列になり 1〜5 件に収まる
  And JSON でないレスポンスは自動補正され、補正不能なら例外が送出される

Scenario: ヒット件数分岐ロジックを 0/1/5/50/120 で網羅する
  Given 各ヒット件数に対応するモック結果を用意する
  When pnpm test -- --filter search-branching を実行する
  Then 0 件は緩和提案→再検索、1 件は即時出力、5 件はリランキング、50 件はベクトル検索、120 件は追加質問ループに入ることをアサートする

Scenario: 差分クロールの日時比較が境界値で正しく動作する
  Given drive_sync_state.drive_modified_at が "2024-09-10T00:00:00Z" である
  And Drive から "2024-09-10T00:00:00Z" と "2024-09-10T00:00:01Z" のファイルが返るモックを用意する
  When diff モードのフィルタを生成するユーティリティをテストする
  Then 等しいタイムスタンプのファイルは除外され、後者のみ処理対象になる
```

### T2: モック e2e（クローラー）
```gherkin
Scenario: 小規模フォルダをモックでクロールし非テキストをスキップする
  Given Drive モックが Doc1, PDF1, 画像1 を返し Doc/PDF は本文を持ち画像はテキストなしとする
  When pnpm test -- --filter crawler-e2e を実行する
  Then Doc1 と PDF1 に要約とキーワードが生成され Supabase モックへ upsert される
  And 画像1 は "unsupported mime" ログとともにスキップされる
  And drive_sync_state.drive_modified_at が処理したファイルの最大 modifiedTime に更新される
```

### T3: モック e2e（検索ループ）
```gherkin
Scenario: ヒット件数に応じた検索ループがモックで検証できる
  Given Drive/Supabase/OpenAI のモックが 0 件→再検索→1 件、5 件、50 件、120 件のケースを返す
  When pnpm test -- --filter search-e2e を実行する
  Then 0 件時に緩和提案後の再検索が走り、1 件時は即終了する
  And 5 件時はリランキング結果が表示用データとして整形される
  And 50 件時は embedding を作成し k=20 のベクトル検索結果上位10件を選択する
  And 120 件時は追加質問を生成し SEARCH_MAX_LOOP_COUNT 回で上限メッセージを出して終了する
```

### T4: テストフィクスチャとモック共通化
```gherkin
Scenario: Drive/OpenAI/Supabase のモックが共通フィクスチャで再利用できる
  Given tests/fixtures 配下に Drive ファイル一覧・OpenAI 生成結果・Supabase upsert/search のレスポンスが定義されている
  When crawler-e2e と search-e2e のテストスイートを実行する
  Then 両方のスイートが同じフィクスチャを参照しモック呼び出し回数とパラメータをアサートできる
  And フィクスチャ更新手順が README またはコメントで明示されている
```

### T5: テスト実行とレポート
```gherkin
Scenario: pnpm test がワンコマンドで主要分岐をカバーする
  Given 開発環境で全テストを実行可能な依存関係がインストールされている
  When pnpm test を実行する
  Then ユニットとモック e2e がすべてパスし、失敗時は期待メッセージを含む出力で原因を特定できる
  And ドキュメントに「負荷テストは PoC 対象外」と明示されている
```
