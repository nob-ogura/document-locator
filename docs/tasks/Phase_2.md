# フェーズ 2: Supabase / DB アクセス実装 (P0)

※ 前提: 実装するコードは TypeScript を使用する。

## タスク一覧

- T1: Supabase に `pgvector` 拡張と `files` / `crawler_state` テーブルを作成するためのマイグレーションスクリプトを用意する
- T2: `.env` から Supabase 接続情報を読み込み、接続クライアントを初期化する Supabase 接続モジュールを実装する
- T3: Supabase 接続時にエラーが発生した場合に、リトライまたはわかりやすいエラーメッセージを出力するエラーハンドリングを実装する
- T4: `files` テーブルに対して単一レコードの upsert を行う関数を実装する
- T5: Drive 側で削除されたファイルを表現するための論理削除または削除マークを付与する関数を実装する
- T6: `files` テーブルに対して、Embedding ベクトルと `file_id` のリストを入力として関連度上位 N 件を返すベクトル検索関数を実装する
- T7: `crawler_state` テーブルに Start Page Token を保存・取得するための関数を実装する

## 受入基準 (Gherkin)

### T1: pgvector 拡張とテーブル定義のマイグレーション

```gherkin
Feature: Supabase migrations for pgvector and tables

  Scenario: マイグレーションを適用すると pgvector と必要なテーブルが作成される
    Given Supabase 上の対象データベースに対してマイグレーションが未適用である
    When 開発者が リポジトリに用意されたマイグレーションスクリプトを Supabase の管理画面または CLI から適用する
    Then データベースに pgvector 拡張が有効化されている
    And `files` テーブルが `file_id`, `file_name`, `summary`, `keywords`, `embedding`, `updated_at`, `created_at` を含むスキーマで作成されている
    And `crawler_state` テーブルが Start Page Token を保存するためのカラムを含むスキーマで作成されている
```

### T2: Supabase 接続モジュールの実装

```gherkin
Feature: Supabase connection module

  Scenario: .env に Supabase 接続情報が設定されているときに接続できる
    Given プロジェクトルートに `.env` ファイルが存在する
    And `.env` に Supabase の URL と API キーなどの接続情報が正しく設定されている
    When 開発者が Supabase 接続モジュールを利用する CLI コマンドを実行する
    Then Supabase クライアントの初期化が成功し
    And 接続エラーが発生したことを示すログやエラーメッセージが出力されない
```

### T3: 接続エラー時のエラーハンドリング

```gherkin
Feature: Supabase connection error handling

  Scenario: Supabase 接続情報が誤っている場合にわかりやすいエラーが出力される
    Given `.env` に存在しないホスト名など誤った Supabase 接続情報が設定されている
    When 開発者が Supabase 接続モジュールを利用する CLI コマンドを実行する
    Then CLI プロセスは非 0 の終了コードで終了する
    And 標準エラー出力に 接続に失敗したことと原因の概要を説明するメッセージが出力される
    And ログに ERROR レベルで Supabase 接続エラーであることがわかるメッセージが出力されている
```

### T4: `files` テーブルの upsert 関数

```gherkin
Feature: Upsert file record into files table

  Scenario: 同一 file_id のレコードが存在しない場合に新規挿入される
    Given Supabase 上の `files` テーブルに `file_id="abc123"` のレコードが存在しない
    When 開発者が upsert 関数を呼び出し `file_id="abc123"` とその他のメタデータを渡す
    Then `files` テーブルに `file_id="abc123"` のレコードが 1 件挿入されている

  Scenario: 同一 file_id のレコードが存在する場合に更新される
    Given Supabase 上の `files` テーブルに `file_id="abc123"` のレコードが既に存在し summary が "old" である
    When 開発者が upsert 関数を呼び出し `file_id="abc123"` かつ summary が "new" のデータを渡す
    Then `files` テーブルの `file_id="abc123"` のレコードが 1 件のみ存在する
    And そのレコードの summary が "new" になっている
```

### T5: Drive 側削除への追従のための論理削除または削除マーク

```gherkin
Feature: Logical delete or delete mark for files

  Scenario: Drive 側で削除されたファイルに削除マークが付与される
    Given Supabase 上の `files` テーブルに `file_id="to-delete"` のレコードが存在し 削除フラグが false である
    When クローラーが Drive 側の削除情報を検知し 削除マーク付与用の関数を呼び出す
    Then `files` テーブルの `file_id="to-delete"` のレコードに削除フラグが true として保存される
    And ベクトル検索の対象から削除フラグが true のレコードが除外されるようにクエリが定義されている
```

### T6: ベクトル検索関数 (`files` + `file_id` フィルタ)

```gherkin
Feature: Vector search with file_id filter

  Scenario: Embedding ベクトルと file_id リストを指定して関連度上位 N 件を取得できる
    Given Supabase 上の `files` テーブルに少なくとも 3 件以上のレコードが存在し それぞれに embedding が設定されている
    And そのうち 2 件の `file_id` だけが file_id フィルタのリストに含まれている
    When 開発者が Embedding ベクトルと file_id フィルタのリストと 取得件数 N=2 を引数にベクトル検索関数を呼び出す
    Then 返却された結果の件数は高々 2 件である
    And 返却された各レコードの `file_id` はフィルタリストに含まれる値のみである
    And 結果は Embedding ベクトルとの類似度が高い順に並んでいる
```

### T7: `crawler_state` テーブルの Start Page Token 保存 / 取得関数

```gherkin
Feature: Save and load start page token in crawler_state

  Scenario: Start Page Token を保存後に同じ値を取得できる
    Given Supabase 上の `crawler_state` テーブルが存在する
    And テーブルに Start Page Token を表すレコードが存在しない
    When 開発者が Start Page Token 保存関数を呼び出し 値として "token-123" を渡す
    And 続けて Start Page Token 取得関数を呼び出す
    Then 取得した Start Page Token の値が "token-123" である

  Scenario: 既存の Start Page Token が更新される
    Given Supabase 上の `crawler_state` テーブルに Start Page Token として "token-old" を保持するレコードが存在する
    When 開発者が Start Page Token 保存関数を呼び出し 値として "token-new" を渡す
    And 続けて Start Page Token 取得関数を呼び出す
    Then 取得した Start Page Token の値が "token-new" である
```
