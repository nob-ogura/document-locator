# スモークテスト 最小セット - タスク一覧

> 対象: docs/Plan.md 「スモークテスト（フェーズ6後半・7前半で実施する最小セット）」に基づく。

### 1. スモーク用フォルダと環境の準備
- 検証用フォルダ（例 `smoke_drive_folder_id`）に Doc1 / PDF1 / 画像1 を配置し、書き込み操作は避ける。
- `.env.production` をスモーク実行用に読み込み、鍵は実環境のものを用いる。
- crawler / search CLI は `--env` フラグ非対応のため、実行前に `.env.production` を `.env` へコピーして読み込ませる（例 `cp .env.production .env`）。必要に応じて作業後に元へ戻す。
- Gherkin:
```gherkin
Scenario: スモーク用フォルダが既定構成で存在する
  Given smoke_drive_folder_id に Google Doc, PDF, 画像が各1件存在する
  And フォルダ内のファイルは上書き・削除を行わない運用である
  And .env.production に Drive/OpenAI/Supabase の有効な鍵が設定されている
  When 作業者がスモークテストを開始する
  Then 3種類のファイルを読み取り専用で利用できる
  And 書き込みが必要な場合のみ smoke_output/ 配下に出力する
```

### 2. 認証とターゲットフォルダ存在確認
- 実行ログにアクセストークン更新が出力され、対象フォルダの列挙が成功することを確認する。
- Gherkin:
```gherkin
Scenario: 認証が成功しターゲットフォルダを列挙できる
  Given .env.production を読み込んでいる
  When "pnpm crawler --mode diff --limit 5" を smoke_drive_folder_id を対象に実行する
  Then INFO ログに "google drive: refreshed access token" が1行含まれる
  And ターゲットフォルダの一覧取得が成功し終了コードは0である
```

### 3. 差分モードの modifiedTime フィルタ付与
- `drive_sync_state` の最新時刻を基に Drive クエリへ `modifiedTime` フィルタが付与されることを確認する。
- Gherkin:
```gherkin
Scenario: 差分モードで modifiedTime フィルタを付与する
  Given drive_sync_state.drive_modified_at が "2024-10-01T00:00:00Z" で保存されている
  And crawler を mode=diff で起動する
  When Drive API への最初のクエリを送信する
  Then クエリ文字列に "modifiedTime > '2024-10-01T00:00:00Z'" が含まれる
  And 取得件数は 2 〜 4 件の範囲に収まる
```

### 4. Doc/PDF 抽出と非対応 MIME スキップ
- Doc と PDF は非空テキストとして抽出され、画像はスキップログが 1 行出力されることを確認する。
- Gherkin:
```gherkin
Scenario: 対応/非対応 MIME を正しく処理する
  Given smoke_drive_folder_id に Doc1, PDF1, 画像1 がある
  When crawler を差分モードで実行する
  Then Doc1 と PDF1 の抽出テキスト長は 1 文字以上である
  And 画像ファイルは処理対象から除外されスキップログが1行出る
```

### 5. リトライ回数と件数サマリの確認
- 429/5xx に遭遇してもリトライは 2 回以内で収束し、件数サマリが期待値に収まることを確認する。
- Gherkin:
```gherkin
Scenario: リトライが2回以内で収束し件数サマリが正しい
  Given Drive または OpenAI API が最初の呼び出しで 429 を返す
  When crawler のバックオフリトライが実行される
  Then 同一リクエストの再試行は2回以内で成功または失敗に確定する
  And INFO ログの取得件数は 3 ±1 件の範囲を報告する
```

### 6. Supabase への反映と smoke_output 後処理
- Upsert と sync state 更新が成功し、必要に応じて作成した `smoke_output/` を実行後に削除する。
- Gherkin:
```gherkin
Scenario: Supabase 反映と後処理が完了する
  Given Doc1 と PDF1 の upsert が成功している
  When 実行が完了する
  Then drive_sync_state.drive_modified_at は処理した最大 modifiedTime に更新される
  And smoke_output/ に生成物がある場合は削除されている
```
