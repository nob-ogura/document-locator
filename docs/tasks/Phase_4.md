# フェーズ4: Google Drive 取得・テキスト抽出基盤 — タスクと受入基準

## タスク一覧
- T1: 認証済み Drive クライアントとターゲットフォルダ限定ユーティリティ（フォルダ存在確認を含む）
- T2: files.list ページングとフル/差分クロール判定骨格（drive_sync_state 連携、mode=auto/full/diff）
- T3: Google ドキュメントのテキスト抽出（files.export text/plain、文字列返却ユーティリティ）
- T4: PDF のテキスト抽出（files.get alt=media + pdf-parse、バイナリ→文字列）
- T5: MIME フィルタと非テキストスキップ＋共通バックオフ（429/5xx リトライ適用、スキップログ出力）

## 受入基準（Gherkin）

### T1: 認証済み Drive クライアントとターゲットフォルダ限定ユーティリティ
```
Scenario: ターゲットフォルダ ID に限定した Drive クライアントを生成できる
  Given .env に GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_TARGET_FOLDER_IDS が設定されている
  When createGoogleDriveClient(config) を呼び出し driveClient.folders.ensureTargetsExist() を実行する
  Then Google Drive API への認証トークンが取得される
  And GOOGLE_DRIVE_TARGET_FOLDER_IDS で指定した各フォルダが存在しない場合は例外を投げる
  And driveClient.files.list() が常に指定フォルダ配下に限定されたクエリを組み立てる
```

### T2: files.list ページングとフル/差分クロール判定骨格
```
Scenario: mode=auto で drive_sync_state が無い場合にフルクロールになる
  Given drive_sync_state が空である
  And crawler の実行モードが auto に設定されている
  When listDriveFilesPaged({ mode: "auto" }) を実行する
  Then files.list が pageSize=100 で複数回呼ばれ nextPageToken を使って全件取得する
  And 取得クエリに modifiedTime フィルタは含まれない

Scenario: mode=diff で drive_sync_state を用いて差分クロールする
  Given drive_sync_state.drive_modified_at が "2024-09-01T00:00:00Z" で保存されている
  When listDriveFilesPaged({ mode: "diff" }) を実行する
  Then files.list のクエリに "modifiedTime > '2024-09-01T00:00:00Z'" が含まれる
  And pageSize=100 で nextPageToken に従って最後まで繰り返す
```

### T3: Google ドキュメントのテキスト抽出
```
Scenario: Google ドキュメントを text/plain で抽出する
  Given MIME タイプが "application/vnd.google-apps.document" の Drive ファイルがある
  When fetchGoogleDocText(fileId) が files.export(fileId, "text/plain") を呼び出す
  Then 戻り値が UTF-8 の文字列として得られ、空文字ではない
  And 429/5xx 応答時には共通の指数バックオフが適用される
```

### T4: PDF のテキスト抽出
```
Scenario: PDF を取得して pdf-parse でテキスト化できる
  Given MIME タイプが "application/pdf" の Drive ファイルがある
  And files.export(fileId, "text/plain") が 400 を返す設定になっている
  When fetchPdfText(fileId) が files.get(fileId, { alt: "media" }) でバイナリを取得し pdf-parse に渡す
  Then 戻り値に PDF 本文が文字列として含まれる
  And 429/5xx 応答時には共通の指数バックオフが適用される
```

### T5: MIME フィルタと非テキストスキップ＋共通バックオフ
```
Scenario: 非対応 MIME をスキップログに記録する
  Given crawler が image/png と application/zip のファイルを受け取る
  When extractTextOrSkip(fileMeta) を実行する
  Then これら MIME はテキスト抽出を試行せず "skip: unsupported mime_type" を INFO か WARN で 1 行ログ出力する

Scenario: Drive API 429 応答で指数バックオフが働く
  Given files.list が初回 429, 2 回目 200 を返すモックである
  When listDriveFilesPaged を実行する
  Then リトライ間隔が 1 秒 → 2 秒 となり合計 2 回で成功する
  And ロガーにリトライ回数と待機秒が記録される
```
