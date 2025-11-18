# document-locator

生成AIとベクトル検索を活かして、Google Drive 上のドキュメントを**権限を遵守しながらセマンティック検索**できるようにする CLI ツールの PoC（概念実証）です。

PoC では、`docs/Concept.md` および `docs/Requirements.md` で定義された最小構成にフォーカスし、

- Google Drive クローラー CLI
- セマンティック検索 CLI

の 2 つのコンポーネントを通じて、次の価値が検証対象となります。

- ユーザーごとの Google Drive 権限を厳格に守ったまま検索できること
- LLM + ベクトル検索により、自然文クエリから意味的に関連するドキュメントを見つけられること

詳細なコンセプトや要件は以下を参照してください。

- 概念レベルの設計: `docs/Concept.md`
- 要件定義: `docs/Requirements.md`
- 実装計画: `docs/Plan.md`

## 前提

- Node.js 18 以上
- `.env` に、少なくとも次の情報を設定していること
  - `GOOGLE_DRIVE_TARGET_FOLDER_ID`（クロール対象フォルダ ID、`,` 区切りで複数指定可能）
  - LLM / Embedding / Supabase / `felores/gdrive-mcp-server` に関する接続情報

> ※ `.env` の詳細な項目は `docs/Requirements.md` を参照してください。

## インストール / セットアップ（開発者向け）

リポジトリをクローンした後、依存パッケージをインストールします。

```bash
npm install
```

その後、`.env` を作成し、必要な環境変数を設定します。

```bash
cp .env.example .env  # 例: ひな型を用意する場合
```

## Google Drive クローラー CLI の概要

Google Drive の特定フォルダ配下のファイルをクロールし、ファイル要約やキーワード、Embedding を生成して Supabase (Postgres + pgvector) に保存する CLI です。

- 差分検出（`changes.list` / Start Page Token）による効率的な更新
- LLM による要約・キーワード生成
- Embedding によるベクトル検索向けインデックス作成

### 典型的な実行例

```bash
npx document-locator crawl \
  --target-folder "$GOOGLE_DRIVE_TARGET_FOLDER_ID"
```

想定される挙動（PoC の骨子）:

- `.env` から `GOOGLE_DRIVE_TARGET_FOLDER_ID` や接続情報を読み込む
- `felores/gdrive-mcp-server` を通じて Drive 上のファイル一覧 / 差分を取得する
- 各ファイルについて要約・キーワード・Embedding を生成し、Supabase に upsert する

## セマンティック検索 CLI の概要

ユーザーの自然文クエリを入力として、ユーザー自身の閲覧権限を厳格に守りつつ、意味的に関連するドキュメントを検索する CLI です。

- `felores/gdrive-mcp-server` による権限フィルタ済み全文検索
- Supabase / pgvector によるベクトル検索
- ヒット件数に応じた LLM による絞り込み・リランキング

### 典型的な実行例

```bash
npx document-locator search \
  "昨月のプロジェクト X のレトロスペクティブ資料"
```

想定される挙動（PoC の骨子）:

- クエリからキーワードや期間を抽出し、`felores/gdrive-mcp-server` でユーザー権限に基づく全文検索を実行
- ヒット件数に応じて、キーワード絞り込み / ベクトル検索 / LLM によるリランキングを行う
- 最終的に 10 件程度に絞り込んだ結果について、ファイル名・要約・更新日時・Google Drive リンクを標準出力に表示する

---

この README はフェーズ 1 (P0) 時点での骨子レベルの記述です。  
実装の詳細やインタフェース仕様は、`docs/Concept.md` / `docs/Requirements.md` / `docs/Plan.md` を参照しながら適宜アップデートしてください。

