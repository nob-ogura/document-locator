# document-locator

Google Drive 検索 CLI を動かすために必須な Google OAuth 認証情報の取得手順をまとめます。以下の 3 つの環境変数値を用意し、`.env` に設定してください。
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

## Google API 認証情報の作成
1. Google Cloud コンソールで新しいプロジェクトを作成する（既存でも可）。
2. 「API とサービス > ライブラリ」で **Google Drive API** を有効化する。
3. 「API とサービス > OAuth 同意画面」でユーザータイプを External に設定し、Scopes に `https://www.googleapis.com/auth/drive.readonly` を追加。テストユーザーに実行する Google アカウントを登録する。
4. 「API とサービス > 認証情報 > 認証情報を作成 > OAuth クライアント ID」から **アプリケーションの種類: ウェブ アプリケーション** を選ぶ。
5. 「承認済みのリダイレクト URI」に `https://developers.google.com/oauthplayground` を追加して作成する。
6. 作成ダイアログに表示される **クライアント ID** と **クライアント シークレット** をそれぞれ `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` に転記する。

## リフレッシュトークン（GOOGLE_REFRESH_TOKEN）の取得
OAuth Playground を使うとブラウザだけで発行できます。
1. OAuth Playground を開き、「Use your own OAuth credentials」に上記の `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を入力して「Close」をクリック。
2. Step 1 でスコープ `https://www.googleapis.com/auth/drive.readonly` を入力し「Authorize APIs」。対象の Google アカウントでログインし、アクセス許可を承認する。
3. Step 2 で「Access type: offline」「Force prompt: consent」を選び「Exchange authorization code for tokens」をクリック。
4. 下部のレスポンスに表示される `refresh_token` の値を `GOOGLE_REFRESH_TOKEN` として `.env` に保存する。

### メモ
- 承認に使うアカウントは、クロール対象の Drive フォルダへアクセス権を持つものを選んでください。
- 再発行したい場合は OAuth Playground の Step 2 で再度 `Force prompt: consent` を有効にして交換すると新しいリフレッシュトークンが得られます。
- `redirect_uri_mismatch` が出る場合は、上記 5. のリダイレクト URI が正しく登録されているか（`https://developers.google.com/oauthplayground`）を確認し、デスクトップ クライアントではなくウェブ アプリケーションでクライアント ID を作成してください。
