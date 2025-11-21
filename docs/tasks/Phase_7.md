# フェーズ7 セマンティック検索 CLI 実装 - タスク一覧

> 前提: フェーズ1–6でクロール済みインデックスと OpenAI/Supabase/Drive クライアント枠が整っていること。実鍵利用は「実鍵・実環境利用計画」の「フェーズ7前半〜中盤（安定化）」に従う（前半: OpenAI 実鍵で分岐確認 → 少件数の Drive 実鍵、 中盤: Supabase ベクトル検索パラメータ計測と調整、スモークテスト②実施）。

### 1. CLI エントリとクエリ/オプションパース
- `search [options] <query>` を commander で実装。`--after`, `--before` は ISO 日付、`--mime` は MIME 文字列。`SEARCH_MAX_LOOP_COUNT` を環境から読み（必須）、欠落時は起動エラー。
- クエリ文字列とフィルタを構造体化し以降の処理に渡す。
- Gherkin:
```gherkin
Scenario: クエリとフィルタを正しくパースする
  Given 環境変数 SEARCH_MAX_LOOP_COUNT が "3" である
  When "pnpm search --after 2024-09-01 --before 2024-09-30 --mime application/pdf \"レポート\"" を実行する
  Then CLI は after を "2024-09-01", before を "2024-09-30", mime を "application/pdf" として受け付ける
  And 必須環境変数が欠落していれば終了コード 1 とエラーメッセージで終了する
```

### 2. キーワード抽出と初期 Drive 検索
- GPT-4o mini で 3–5 件のキーワードを JSON 配列で抽出（固有名詞優先、`temperature=0`）。  
- Drive API を `GOOGLE_DRIVE_TARGET_FOLDER_IDS` 配下に限定し、期間/MIME フィルタとキーワードを適用して検索。
- Gherkin:
```gherkin
Scenario: クエリからキーワードを抽出し Drive を初期検索する
  Given クエリ "週次レポート 9月 売上" がある
  When search コマンドを実行する
  Then GPT-4o mini に 3〜5 件のキーワード抽出を依頼する
  And Drive 検索ではターゲットフォルダ限定で期間と MIME フィルタを適用する
  And 抽出したキーワードが空配列の場合は Drive 検索はクエリ文字列のみで行う
```

### 3. ヒット件数算出と分岐ロジック
- Drive 検索結果の `file_id` と `drive_file_index` の積集合サイズをヒット件数とし、Design.md の件数分岐に従う（0 / 1 / 2–10 / 11–100 / 101+）。
- 101+ 件では追加質問生成→ユーザー回答→再検索を 1 ループとし、`SEARCH_MAX_LOOP_COUNT` を超えたら終了メッセージを返す。
- Gherkin:
```gherkin
Scenario: ヒット件数に応じて分岐する
  Given ヒット件数が 120 件である
  When search コマンドを実行する
  Then 追加質問を生成しユーザー回答を反映して再検索する
  When 2 回目の検索後も 101 件以上で SEARCH_MAX_LOOP_COUNT に達する
  Then 「10 件以下に絞り込めませんでした」メッセージを出して終了する
```

### 4. 2–10 件リランキングと 11–100 件ベクトル検索
- 2–10 件: Drive メタデータ＋要約を LLM に渡し順位付きリランキングで 10 件以内を表示。  
- 11–100 件: クエリ＋キーワードを embedding 化し積集合を Supabase ベクトル検索（Design k=20 取得、上位 10 件表示）。  
- Gherkin:
```gherkin
Scenario: 件数帯に応じた結果提示
  Given ヒット件数が 5 件である
  When search コマンドを実行する
  Then 5 件の候補を LLM に渡しリランキングした順で表示する
  Given ヒット件数が 50 件である
  When search コマンドを実行する
  Then クエリとキーワードで embedding を作成し Supabase に k=20 で検索する
  And 上位 10 件を表示する
```

### 5. 0 件時の緩和・1 件時の即時出力
- 0 件: キーワード削減もしくは期間/MIME 緩和案を LLM で生成し再検索。キーワード 1 件でも 0 の場合は即「見つかりませんでした」。  
- 1 件: 取得した 1 件を即出力して終了。
- Gherkin:
```gherkin
Scenario: 0 件時のリトライと 1 件時の即終了
  Given 初回検索のヒット件数が 0 件である
  When search コマンドを実行する
  Then LLM がフィルタ緩和またはキーワード削減案を提案し再検索する
  When 再検索後もキーワードが 1 件かつヒット 0 件である
  Then 「見つかりませんでした」を表示して終了する
  Given ヒット件数が 1 件である
  When search コマンドを実行する
  Then その 1 件のみを表示して終了する
```

### 6. 出力フォーマットとリンク生成
- 各結果に番号、ファイル名、要約（`SUMMARY_MAX_LENGTH` 以内）、Drive 直リンクを表示。  
- CLI 標準出力は改行とインデントを Design.md の例に合わせる。
- Gherkin:
```gherkin
Scenario: 結果のフォーマットが仕様に従う
  Given 3 件の検索結果がある
  When search コマンドが結果を表示する
  Then 各行に "[n] ファイル名" と "要約:" と "Link:" が含まれる
  And 要約は SUMMARY_MAX_LENGTH 文字以内に切り詰められる
```

### 7. ログ・リトライ・終了コード
- INFO でヒット件数、分岐パス、再検索回数をサマリ。DEBUG で LLM/embedding トークン使用量と Drive/Supabase 呼び出しを記録。  
- 429/5xx は共通指数バックオフ（1s→2s→4s→8s→16s 最大 5 回）。致命エラー時は非0終了。
- Gherkin:
```gherkin
Scenario: ログとリトライが動作する
  Given OpenAI 429 が発生する
  When search コマンドを実行する
  Then バックオフ 5 回以内でリトライし成功すれば処理を続行する
  And INFO ログにヒット件数と選択された分岐が出力される
  When 致命的な例外が起きる
  Then 終了コードは非ゼロである
```

### 8. ユニットテストとモック検証
- ヒット件数 0/1/5/50/120 の分岐テスト、出力フォーマット検証、ループ上限メッセージ確認を Vitest で実装。モッククライアントで Drive/LLM/Supabase 呼び出し回数をアサート。
- Gherkin:
```gherkin
Scenario: 分岐ロジックのユニットテストが通る
  Given モックデータでヒット件数 0, 1, 5, 50, 120 のケースを準備する
  When pnpm test -- --filter search を実行する
  Then すべてのケースで期待どおりの分岐と出力が検証されテストがパスする
```

### 9. 実鍵ステージング（フェーズ7前半〜中盤）
- 前半: `.env.production` で OpenAI 実鍵を使い、モック Drive/Supabase と組み合わせて分岐ロジックを実データで 1 回確認。安定後、Drive 実鍵を少件数フォルダに当てて検索結果を確認。  
- 中盤: Supabase ベクトル検索の `k=20`, `lists`, `probes` を実データで計測し、必要であれば `probes` を調整してレスポンスと精度のバランスを取る。スモークテスト②（Plan 記載の判定軸）を実行しログを保存。
- Gherkin:
```gherkin
Scenario: 実鍵で分岐とベクトル検索を安定化させる
  Given .env.production に OpenAI と Drive と Supabase の実鍵が設定されている
  When 検証用フォルダに対して "pnpm search \"テストクエリ\"" を実行する
  Then 0/1/10/50 件帯を網羅する分岐が実鍵で成功する
  And ベクトル検索では k=20 で取得し probes を計測値に応じて調整できる
  And スモークテスト②の判定軸を満たすログが残る
```
