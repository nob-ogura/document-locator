# フェーズ7 セマンティック検索 CLI 実装 - タスク一覧

> 前提: フェーズ1–6でクロール済みインデックスと OpenAI/Supabase/Drive クライアント枠が整っていること。実鍵利用は「実鍵・実環境利用計画」の「フェーズ7前半〜中盤（安定化）」に従う（前半: OpenAI 実鍵で分岐確認 → 少件数の Drive 実鍵、 中盤: Supabase ベクトル検索パラメータ計測と調整、スモークテスト②実施）。

### 1. CLI エントリとクエリ/オプションパース
- `search [options] <query>` を commander で実装。`--after`, `--before` は ISO 日付、`--mime` は MIME 文字列に加え、類似度しきい値 `--similarity <float>`（デフォルト 0.70）と最大取得件数 `--limit <n>`（デフォルト 80）を受け付ける。
- `SEARCH_MAX_LOOP_COUNT` を環境から読み（必須）、欠落時は起動エラー。クエリ文字列とフィルタ/しきい値/件数を構造体化し以降の処理に渡す。
- Gherkin:
```gherkin
Scenario: クエリとフィルタを正しくパースする
  Given 環境変数 SEARCH_MAX_LOOP_COUNT が "3" である
  When "pnpm search --after 2024-09-01 --before 2024-09-30 --mime application/pdf --similarity 0.72 --limit 40 \"レポート\"" を実行する
  Then CLI は after を "2024-09-01", before を "2024-09-30", mime を "application/pdf", similarity を 0.72, limit を 40 として受け付ける
  And 必須環境変数が欠落していれば終了コード 1 とエラーメッセージで終了する
```

### 2. キーワード抽出と初期ベクトル検索
- GPT-4o mini で 1–5 件のキーワードを JSON 配列で抽出（固有名詞優先、`temperature=0`）。
- 「クエリ + キーワード」を text-embedding-3-small で embedding 化し、Supabase/pgvector に期間・MIME フィルタ付きでベクトル検索する（k は `--limit` の値を上限に設定）。Drive API は検索起点では使わず、後続の存在確認や差分取得に限定する。
- Gherkin:
```gherkin
Scenario: クエリからキーワードを抽出しベクトル検索する
  Given クエリ "週次レポート 9月 売上" がある
  When search コマンドを実行する
  Then GPT-4o mini に 1〜5 件のキーワード抽出を依頼する
  And クエリとキーワードを結合して embedding を作成する
  And Supabase のベクトル検索に期間/MIME フィルタを適用し k は --limit を上限にする
```

### 3. ヒット件数・類似度に基づく分岐ロジック
- 初回ベクトル検索の件数と最上位類似度で分岐する。
  - 50 件以上 **または** 最上位類似度 < 0.75: 追加質問を生成しユーザー回答を反映してクエリを拡張→再Embedding→類似度しきい値 0.82 で再検索。
  - 10–49 件: 上位 20 件に絞り、類似度 0.75 未満は除外。必要に応じてクエリリライト→再Embedding→再検索。
  - 2–9 件: LLM リランキングで表示順を決定。
  - 1 件: そのまま表示。
  - 0 件: 類似度しきい値を 0.60 まで緩和し、キーワードも削減して再検索。再び 0 件なら「見つかりませんでした」。
- 追加質問ループは `SEARCH_MAX_LOOP_COUNT` で打ち切り、超過時は「10 件以下に絞り込めませんでした」を表示。
- Gherkin:
```gherkin
Scenario: ヒット件数と類似度に応じて分岐する
  Given 初回ベクトル検索のヒット件数が 120 件である
  When search コマンドを実行する
  Then 追加質問を生成しユーザー回答を反映して再検索する
  When 2 回目の検索後も 50 件以上で SEARCH_MAX_LOOP_COUNT に達する
  Then 「10 件以下に絞り込めませんでした」メッセージを出して終了する
```

### 4. 件数帯別の提示方法
- 2–9 件: Drive メタデータ＋要約を LLM に渡し順位付きリランキングで最大 9 件を表示。  
- 10–49 件: 上位 20 件を保持し、類似度 0.75 未満を除外。必要に応じてクエリリライト後に再検索し、最終的に 10 件表示。  
- 50 件以上または最上位 <0.75: 追加質問経由の再検索結果を表示（ループごとに 10 件以内）。
- Gherkin:
```gherkin
Scenario: 件数帯に応じた結果提示
  Given ヒット件数が 5 件である
  When search コマンドを実行する
  Then 5 件の候補を LLM に渡しリランキングした順で表示する
  Given ヒット件数が 35 件である
  When search コマンドを実行する
  Then 上位 20 件を保持し類似度 0.75 未満を除外する
  And 必要に応じてクエリリライト後に再検索し最終 10 件を表示する
```

### 5. 0 件時の緩和・1 件時の即時出力
- 0 件: 類似度しきい値を 0.60 まで下げ、キーワード削減案を LLM で生成して再検索。再び 0 件なら「見つかりませんでした」。  
- 1 件: 取得した 1 件を即出力して終了。
- Gherkin:
```gherkin
Scenario: 0 件時のリトライと 1 件時の即終了
  Given 初回検索のヒット件数が 0 件である
  When search コマンドを実行する
  Then 類似度しきい値を 0.60 まで緩和しキーワード削減案を LLM が提案し再検索する
  When 再検索後もヒット 0 件である
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
- 前半: `.env.production` で OpenAI 実鍵を使い、モック Supabase → 実 Supabase の順にベクトル検索分岐を実データで確認。安定後に Drive 実鍵を少件数フォルダへ当て、取得ファイルの存在確認や `modifiedTime` 差分取得のみ行う。
- 中盤: Supabase ベクトル検索の `k`, `lists`, `probes` を実データで計測し、必要であれば `probes` を調整してレスポンスと精度のバランスを取る。スモークテスト②（Plan 記載の判定軸）を実行しログを保存。
- Gherkin:
```gherkin
Scenario: 実鍵で分岐とベクトル検索を安定化させる
  Given .env.production に OpenAI と Drive と Supabase の実鍵が設定されている
  When 検証用フォルダに対して "pnpm search \"テストクエリ\"" を実行する
  Then 0/1/10/50 件帯を網羅する分岐が実鍵で成功する
  And ベクトル検索では k を --limit に合わせて取得し probes を計測値に応じて調整できる
  And スモークテスト②の判定軸を満たすログが残る
```
