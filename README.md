# document-locator

生成AIとベクトル検索を活用して、Google Drive 上のドキュメントを**権限を遵守したセキュアなセマンティック検索**で横断的に探せるかを検証する PoC (概念実証版) 用 CLI ツールです。  
`.env` に指定したフォルダ配下のみを対象に、クローラーで要約・Embedding を作成し、そのインデックスを使って自然文で検索できるかどうかを確認することが本システムの目的です。

PoC では、以下の価値仮説を最小構成で検証します。

- Google Drive の閲覧権限を厳格に守ったまま、生成AIとベクトル検索を組み合わせたセマンティック検索が実現できること
- 差分クロール + ベクトル検索により、現実的なレスポンス時間で目的のドキュメントに到達できること

詳細なコンセプトと要件は次のドキュメントにまとめています。

- 概念設計・アーキテクチャ: [docs/Concept.md](docs/Concept.md)
- 要件定義 (PoC のスコープ): [docs/Requirements.md](docs/Requirements.md)

## 構成概要

document-locator は、次の 2 つの CLI コンポーネントで構成されます。

### Google Drive クローラー CLI (`document-locator crawl`)

- `.env` に設定した `GOOGLE_DRIVE_TARGET_FOLDER_ID` 配下のフォルダを対象に Google Drive をクロールします。
- 各ファイルのメタデータや要約文、検索用キーワード、Embedding を生成し、Supabase (Postgres + pgvector) に保存することを想定しています。
- 定期実行 (Cron 等) を前提とし、変更差分のみを追跡することで API 負荷と処理時間を抑える設計です。

### セマンティック検索 CLI (`document-locator search`)

- ユーザーの自然文クエリを受け取り、生成AIを用いて検索キーワードや期間条件を抽出します。
- `felores/gdrive-mcp-server` 経由の全文検索と Supabase 上のベクトル検索を組み合わせ、閲覧権限を持つファイルだけを候補としたセマンティック検索を行うことを想定しています。
- ヒット件数に応じて、追加のキーワード絞り込み・ベクトル検索・LLM によるリランキングなどの分岐ロジックで結果を整理し、ファイル名・要約・リンクを一覧表示します。

## セットアップ (PoC 開発者向け)

1. Node.js (LTS) をインストールします。
2. 依存パッケージをインストールします。

   ```bash
   npm install
   ```

3. TypeScript ソースをビルドします。

   ```bash
   npm run build
   ```

4. プロジェクトルートに `.env` ファイルを作成し、少なくとも次の環境変数を設定します。

   ```bash
   GOOGLE_DRIVE_TARGET_FOLDER_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
   # LLM / Embedding / Supabase / gdrive-mcp-server の接続情報 など
   ```

   詳細な環境変数の要件は [docs/Requirements.md](docs/Requirements.md) を参照してください。

## CLI の利用方法

ビルド後は、`document-locator` コマンドからサブコマンドを実行できます。

### ヘルプの確認

```bash
document-locator --help
```

### Google Drive クローラー CLI の実行例

```bash
# `.env` の GOOGLE_DRIVE_TARGET_FOLDER_ID で指定したフォルダ配下をクロールし、
# 検索用インデックス (要約・Embedding など) を更新する想定のコマンド
document-locator crawl
```

### セマンティック検索 CLI の実行例

```bash
# 「プロジェクトXの会議議事録」を探すセマンティック検索の例
document-locator search "プロジェクトX 会議 議事録"
```

将来的には、クエリ内に含まれる日付や期間指定 (例:「2024年4月以降」) を読み取り、`updated_at` に対するフィルタとして利用することを想定しています。

---

本リポジトリは PoC フェーズのため、実装は `docs/Concept.md` / `docs/Requirements.md` に定義された最小限のスコープに絞って進めています。詳細な背景・設計意図についてはこれらのドキュメントを参照してください。

