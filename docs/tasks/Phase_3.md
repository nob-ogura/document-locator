# フェーズ3: DB スキーマとリポジトリ — タスクと受入基準

## タスク一覧
- T1: `drive_file_index` の DDL 作成（pgvector 対応・インデックス含む）を `sql/` 配下に追加
- T2: `drive_sync_state` の DDL 作成（id=global の PK 定義）を `sql/` 配下に追加
- T3: `pnpm db:apply` で `sql/` のファイルを昇順適用するスクリプト整備（環境変数チェック付き）
- T4: Supabase リポジトリ（`drive_file_index` 用）実装：upsert／ID 指定取得／ベクトル検索(k=20, probes=10, lists=100 前提)
- T5: Supabase リポジトリ（`drive_sync_state` 用）実装：最新 drive_modified_at の取得・更新ヘルパー

## 受入基準（Gherkin）

### T1: drive_file_index の DDL とインデックス
```
Scenario: drive_file_index テーブルが設計通りに作成される
  Given pgvector 拡張が有効な空の Supabase データベースがある
  When 開発者が `pnpm db:apply` を実行し sql/00x_drive_file_index.sql を適用する
  Then drive_file_index テーブルが作成され PRIMARY KEY が file_id(TEXT) になる
  And カラムに file_name TEXT NOT NULL, summary TEXT NOT NULL, keywords TEXT[], embedding VECTOR(1536) NOT NULL, drive_modified_at TIMESTAMPTZ NOT NULL, mime_type TEXT NOT NULL が含まれる
  And drive_modified_at に BTree インデックス drive_file_index_drive_modified_at_idx が作成される
  And embedding に ivfflat インデックス drive_file_index_embedding_idx が vector_cosine_ops/lists=100 で作成される
```

### T2: drive_sync_state の DDL
```
Scenario: drive_sync_state テーブルが初期化される
  Given drive_file_index のマイグレーションが終わった Supabase データベースがある
  When `pnpm db:apply` で sql/00x_drive_sync_state.sql を適用する
  Then drive_sync_state テーブルが id TEXT PRIMARY KEY, drive_modified_at TIMESTAMPTZ NOT NULL で作成される
  And id 列の想定値 'global' で重複挿入すると一意制約違反が発生する
```

### T3: db:apply スクリプト
```
Scenario: 環境変数が正しく設定されているときマイグレーションが順序通り適用される
  Given SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が環境変数に設定されている
  And sql/ 配下に番号付きで並ぶ .sql ファイルが存在する
  When 開発者が `pnpm db:apply` を実行する
  Then 各 SQL がファイル名の昇順で適用され終了コード 0 で終了する

Scenario: 必須環境変数が欠落しているときに安全に失敗する
  Given SUPABASE_URL が未設定の状態で `pnpm db:apply` を実行する
  Then スクリプトは非 0 終了し、欠落した変数名を含むエラーメッセージを出力する
```

### T4: drive_file_index リポジトリ
```
Scenario: upsertDriveFileIndex が複数レコードをマージ挿入できる
  Given Supabase クライアントモックが Prefer: resolution=merge-duplicates を解釈する
  When upsertDriveFileIndex([{file_id: "1", file_name: "a", summary: "s", keywords: [], embedding: [0.1], drive_modified_at: "2024-01-01T00:00:00Z", mime_type: "application/pdf"}]) を呼び出す
  Then /rest/v1/drive_file_index への POST が 1 回行われ 201 または 204 で成功する

Scenario: fetchDriveFileIndexByIds が存在する ID のみ返す
  Given drive_file_index に 3 レコードが存在する
  When fetchDriveFileIndexByIds(["x","missing"]) を呼び出す
  Then 戻り値は file_id が "x" の 1 件のみで、欠損 ID は含まれない

Scenario: vectorSearchDriveFileIndex がコサイン類似度順に上位 k を返す
  Given drive_file_index の ivfflat インデックスが作成済みで probes=10, k=20 を指定できる
  When vectorSearchDriveFileIndex(queryEmbedding, {limit: 20, probes: 10, filterFileIds: ["a","b","c"]}) を呼び出す
  Then 最大 20 件がコサイン距離の昇順で返り、file_id は filterFileIds に含まれるものだけになる
```

### T5: drive_sync_state リポジトリ
```
Scenario: getDriveSyncState が未初期化時に null を返す
  Given drive_sync_state テーブルが空である
  When getDriveSyncState() を呼び出す
  Then 戻り値は null になる

Scenario: upsertDriveSyncState が最新の drive_modified_at を保存する
  Given drive_sync_state に id='global' の行が既に存在する
  When upsertDriveSyncState("2024-09-01T10:00:00Z") を呼び出す
  Then 該当行の drive_modified_at が指定の時刻に更新され、1 件が更新されたことをリポジトリが返す
```
