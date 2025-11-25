# Google Drive MCP 移行ガイド

## ゴール
- 既存の Google Drive API 直接呼び出しを、セルフホストした Google Drive MCP サーバ経由の呼び出しに置き換える。
- 既存クロール機能（`files.list` 相当の列挙とファイル取得）と検索 CLI の挙動を変えずに差し替えられるよう、型とインターフェイスは `GoogleDriveClient` 互換で実装する。
- 最終的に Drive API 直呼び出し経路を廃止し、MCP 経路に一本化する（ロールバックしない前提）。

## 前提と選定
- MCP サーバ候補: `google-drive-mcp`（piotr-agier）。検索・取得・移動・削除までカバーし、ローカルで `npx @piotr-agier/google-drive-mcp` または Docker で常駐可。
- 必要スコープ: Drive の read/write。PoC では read-only で開始し、書き込み系は段階導入。
- 本リポジトリ側は Node.js 22 / pnpm 前提。MCP クライアントは `@modelcontextprotocol/sdk` を利用予定。

## 方針
1. `GoogleDriveClient` を実装する「MCP アダプタ」を新規追加し、既存の `listDriveFilesPaged` などコア処理は変更しない。
2. 移行期間のみ `DRIVE_BACKEND` で `api` / `mcp` を切り替えられるようにし、最終的にフラグと旧実装を削除する。
3. 認証・トークン保存は MCP サーバ側で完結させ、クライアントは MCP への接続情報のみを保持する。
4. 段階導入（PoC → 局所本番 → 全面置換）後は旧経路へ戻さず、そのままクリーンアップする。
5. REST 前提の `GoogleDriveClient` インターフェイスを、MCP と REST の双方で成立する形に先にリファクタする（下記「インターフェイス調整」を実施）。

## 作業ステップ
### 0. 事前準備
- OAuth クレデンシャル（Client ID / Secret）とリフレッシュトークンを用意し、MCP サーバの設定ガイドに従ってトークンファイルを作成。
- `.env` に以下を追加（例）:
  - `DRIVE_BACKEND=mcp`
  - `MCP_DRIVE_ENDPOINT=http://127.0.0.1:3030` （サーバの HTTP/Unix ソケットに合わせて設定）
  - `MCP_DRIVE_AUTH_TOKEN=...` （サーバ側がトークンヘッダを要求する場合のみ）

### 1. MCP サーバのセットアップ（PoC）
- ローカルでサーバを起動:
  - npm: `npx @piotr-agier/google-drive-mcp --port 3030 --token-path ./.mcp/google-drive.json`
  - Docker: `docker run -p 3030:3030 -v $PWD/.mcp:/data piotragier/google-drive-mcp`
- サーバ起動確認: `curl http://127.0.0.1:3030/health` が 200 を返すこと。

### 2. クライアント層の実装
- 新規ファイル（案）: `src/mcp/drive_client.ts`
  - `GoogleDriveClient` を満たす形で以下を実装:
    - `files.list`: MCP の検索ツールを呼び、`q` / `parents` / `pageSize` / `pageToken` を対応付ける。
    - `files.get` / `files.export`: MCP のファイル取得ツールを呼び、必要なら `alt=media` 相当を再現。
    - `folders.ensureTargetsExist`: `targetFolderIds` を MCP のメタデータ取得で検証。
  - 共通のエラーハンドリング・リトライは既存 `http.ts` の `fetchWithRetry` を流用し、ログ出力の粒度を合わせる。
- インターフェイス調整（先行タスク）:
  - `GoogleDriveClient` の戻り値を生の `Response` ではなく DTO（例: `FilesListResult`, `FileExportResult`）に変更し、呼び出し側（`drive.ts`, `text_extraction.ts`）で `response.json()` を行わない形へ移行する。
  - 認証フィールド（`clientId` / `clientSecret` / `refreshToken`）を任意にし、MCP バックエンドでは保持不要とする。
  - 既存 REST 実装には薄い `Response` 互換ラッパーを噛ませて DTO へのパースを内部化し、挙動を維持する。
  - 型変更に伴いテストを更新し、REST と MCP の両モックを用意する。
- 分岐追加:
  - `src/clients.ts` 内 `createExternalClients` にて `config.driveBackend === "mcp"` の場合は新規 MCP クライアントを返す。
  - `AppConfig` / `env.ts` に `driveBackend` と `mcpDriveEndpoint`（必要なら認証ヘッダ）を追加。

### 3. クロール経路の確認
- 既存の `listDriveFilesPaged` / `text_extraction.ts` などは `GoogleDriveClient` に依存しているため、インターフェイス互換が取れていればコード変更は不要の想定。
- 差分クロールに用いている `modifiedTime` は MCP が返す値を信頼する。返却フィールド名の違いがあればアダプタ内で正規化する。

### 4. テスト計画
- ユニット: `tests/clients.test.ts` に MCP モックを追加し、`files.list` と `files.get` の基本経路を検証。
- 統合（ローカル PoC）:
  - `.env.mcp` を用意し `DRIVE_BACKEND=mcp` で `pnpm crawler -- --mode diff -l 10` を実行。
  - `pnpm search -- --query "テスト" --json` で検索経路を確認。
- 回帰: `pnpm verify` を `DRIVE_BACKEND=api` で通常実行し、既存経路が壊れていないことを確認。

### 5. ロールアウト手順
1. PoC: ローカルで MCP バックエンドを有効化し、クロールと検索が通ることを確認（小規模フォルダのみ）。
2. Staging/小規模本番: 環境変数で特定ワーカーのみ `DRIVE_BACKEND=mcp` にし、Supabase への書き込みを監視。
3. 全面切替: すべてのワーカーを `mcp` にし、実運用を継続（この時点で旧 API へのロールバックは想定しない）。
4. クリーンアップ: 安定を確認したら `DRIVE_BACKEND` フラグを除去し、`googleClientId` / `googleClientSecret` / `googleRefreshToken` など旧 API 専用の環境変数とコードパスを削除する。

### 6. 運用・SRE ポイント
- MCP サーバを常駐させる場合は以下を監視対象に追加:
  - ヘルスチェック `/health`
  - 429/5xx レート
  - ファイル取得エラー率（特に export/バイナリ変換）
- トークンファイルのパーミッションとバックアップを明確化（最低 600、永続ボリューム上に配置）。
- 障害時は MCP サーバ再起動・リトライ方針で収束させる。旧 API への切替は行わない想定。

### 7. 既知の制約・検討事項
- Drive Push Notification 相当のリアルタイム検出は MCP 実装に依存する。現行の差分クロールモデルでは未対応のまま。
- 大容量バイナリのストリーム転送や Docs/Slides の編集操作はサーバ実装次第。クロール対象は従来同様テキスト抽出可能な MIME のみに限定する。
- MCP サーバ障害時のフォールバック動作をどう扱うか（即ロールバックか、再試行・遅延キューか）を運用設計で決める。

### 8. 次アクション（最短ルート）
1. `.env.mcp` を用意しローカルで `google-drive-mcp` を起動。
2. `src/mcp/drive_client.ts`（仮）を追加し、`GoogleDriveClient` 互換 API を実装。
3. `env.ts` / `clients.ts` に分岐と新規設定を追加。
4. PoC クロール・検索を実行し、ログと Supabase への書き込みを確認。
5. 問題なければステージングで部分切替を開始。
