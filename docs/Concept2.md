# Google Drive MCP-Only Concept

## 背景
- 現行は Google Drive REST API 直呼び出しを前提にクロール・検索を実装している。
- 目標は Google Drive API を一切使わず、セルフホストの Google Drive MCP サーバを唯一のデータプレーンとして採用すること。
- 既存コア処理（`listDriveFilesPaged` / `text_extraction` など）への影響を最小化しつつ、MCP 経路専用の設定・運用に寄せる。

## コンセプト
1. **MCP 専用バックエンド**: `DRIVE_BACKEND=mcp_only` を導入し、このモードでは REST 資格情報を要求せず、MCP 経路のみを初期化する。
2. **Response 互換シム**: `GoogleDriveClient` 契約を維持するため、MCP クライアントは HTTP 風のオブジェクト（`ok/status/statusText/headers/json()` 等）を返す。既存のリトライ・エラー処理をそのまま利用できる。
3. **トークンレス運用**: 認証情報・トークンの保存は MCP サーバ側で完結。クライアントは `MCP_DRIVE_ENDPOINT` と必要なら `MCP_DRIVE_AUTH_TOKEN` のみを保持する。
4. **API パリティ優先**: `files.list/get/export` のフィールド互換性をアダプタで吸収し、呼び出し元のフィルタ・ページング・`modifiedTime` 判定ロジックを変えない。
5. **計測と段階導入**: MCP 経路の 2xx/4xx/5xx 分布と export 失敗率をロギングし、PoC → 部分切替 → API 資格情報削除の順で進める。

## 設定案
- `DRIVE_BACKEND=mcp_only`
- `MCP_DRIVE_ENDPOINT` (例: `http://127.0.0.1:3030` or `unix:///tmp/mcp.sock`)
- `MCP_DRIVE_AUTH_TOKEN` (任意。サーバがヘッダ認証を要求する場合)
- REST 用の `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` は mcp_only では必須にしない。

## インターフェイス指針
- `GoogleDriveClient.files.list(params)`
  - `q/parents/pageSize/pageToken/orderBy/includeItemsFromAllDrives/supportsAllDrives` を MCP の search ツールへマッピング。
  - MCP が未対応のフィールドはアダプタ内でエラーにし、ログに理由を残す。
- `files.get(fileId, { alt })` / `files.export(fileId, mimeType, ...)`
  - MCP の file/get・export 相当を呼び、`alt=media` 動作を MIME 判定で再現。
- `folders.ensureTargetsExist()`
  - `targetFolderIds` を MCP 側のメタデータ取得で検証。404/非フォルダ/trashed は REST と同じエラー文言を返す。
- エラー・リトライ
  - MCP 応答を `status` に写像し、429/5xx を既存バックオフ判定に通す。
  - ボディは JSON を期待し、失敗時は `body=<text>` を含む詳細ログを出す。

## 実装ステップ（推奨シーケンス）
1. `GoogleDriveClient` 契約を「Response 互換 DTO」に拡張（`ok/status/json()` 必須）。REST 実装に薄いラッパーを追加して既存テストをグリーンにする。
2. `src/mcp/drive_client.ts` を追加し、MCP への RPC を Response 互換 DTO で返す。
3. `env.ts` のバリデーションを `driveBackend === "mcp_only"` のときは REST 資格情報を必須にしない形へ分岐。
4. `createExternalClients` で `mcp_only` を選択した際に MCP クライアントを返すよう分岐を追加。
5. PoC: `.env.mcp` で `pnpm crawler -- --mode diff -l 10` / `pnpm search -- --query "テスト" --json` を実行し、ログで backend=mcp を確認。
6. 部分切替: 一部ワーカーを `mcp_only` にして Supabase 書き込みと失敗率を監視。
7. 完全切替: REST 資格情報を撤去し、`DRIVE_BACKEND` フラグと旧クライアントを削除。

## テスト戦略
- 契約テスト: `tests/clients.test.ts` に MCP モックを追加し、`list`/`get`/`export` が Response 互換 DTO を返し、429/503 でバックオフが働くことを検証。
- 回帰: `drive_list_paging` / `text_extraction` / `pdf_extraction` など既存スペックを `DRIVE_BACKEND=mcp_only` で再実行。
- エラーパス: `folders.ensureTargetsExist` が 404/非フォルダ/trashed で例外を投げることを確認。

## リスクと対応
- **MCP が Drive クエリ構文を完全サポートしない**: 対応不可のフィールドは早期エラーにし、ドキュメントにサポート状況を明記。
- **スループット低下**: ファイル取得・エクスポートを並列制御するレートリミットをアダプタ側で設定可能にする。
- **観測性不足**: ログに `backend: mcp_only` と `status` を必ず含め、失敗率をダッシュボード化。

## 期待される成果
- Google API 資格情報不要でクロール・検索が動く。
- REST 依存コードを最小限に保ちつつ、MCP への一本化を安全に進められる。
- 実運用に必要な監視・テストの筋道が明確になる。
