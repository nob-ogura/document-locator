# フェーズ1: プロジェクト初期設定 — タスクと受入基準

## タスク一覧
- T1: Node.js 22 / pnpm 前提のプロジェクト初期化（`package.json` 作成、`engines.node` 設定、pnpm-lock 生成）
- T2: TypeScript ベース構成（`tsconfig.json` 整備、`src/` 雛形ファイル配置）
- T3: 開発ツール導入（biome 設定と `pnpm lint` スクリプト、vitest 設定と `pnpm test` スクリプト）
- T4: CLI 雛形作成（commander + tsx で `crawler` / `search` コマンドのヘルプ表示まで実装）
- T5: 実行スクリプト整備（`pnpm crawler` `pnpm search` `pnpm db:apply` エントリ、`pnpm lint` `pnpm test` が空プロジェクトで成功）

## 受入基準（Gherkin）

### T1: Node.js 22 / pnpm 前提のプロジェクト初期化
```
Scenario: pnpm プロジェクトを Node 22 前提で再現できる
  Given リポジトリ直下に package.json が存在する
  And package.json の engines.node が ">=22" を満たす
  When 開発者が `pnpm install --frozen-lockfile` を実行する
  Then コマンドが終了コード 0 で完了する
  And pnpm-lock.yaml が生成される
```

### T2: TypeScript ベース構成
```
Scenario: 型チェック可能な TypeScript 雛形がある
  Given リポジトリ直下に tsconfig.json が存在し "target": "ES2022" または同等が設定されている
  And src/ 配下に最低 1 つの TypeScript ファイルがある（ビルド不要の雛形でよい）
  When `pnpm exec tsc --noEmit` を実行する
  Then コマンドが終了コード 0 で完了する
```

### T3: 開発ツール導入（biome / vitest）
```
Scenario: Lint が空プロジェクトで成功する
  Given biome 設定ファイル（例: biome.json）がリポジトリ直下に存在する
  When 開発者が `pnpm lint` を実行する
  Then コマンドが終了コード 0 で完了する

Scenario: テストランナーが実行できる
  Given vitest が devDependencies に含まれている
  When 開発者が `pnpm test` を実行する
  Then コマンドが終了コード 0 で完了し、少なくとも 1 件のサンプルテストが PASS するか 0 件でも失敗しない
```

### T4: CLI 雛形作成（crawler / search）
```
Scenario: crawler コマンドのヘルプが表示できる
  Given commander で定義した crawler エントリが存在する
  When 開発者が `pnpm crawler --help` を実行する
  Then コマンドが終了コード 0 で完了し、出力に "crawler" とオプション説明が含まれる

Scenario: search コマンドのヘルプが表示できる
  Given commander で定義した search エントリが存在する
  When 開発者が `pnpm search --help` を実行する
  Then コマンドが終了コード 0 で完了し、出力に "search" とオプション説明が含まれる
```

### T5: 実行スクリプト整備
```
Scenario: package.json のスクリプトで基本コマンドが起動できる
  Given package.json に "crawler", "search", "db:apply", "lint", "test" のスクリプトが定義されている
  When 開発者が `pnpm lint` と `pnpm test` を実行する
  Then それぞれ終了コード 0 で完了する
  When 開発者が `pnpm crawler --help` と `pnpm search --help` を実行する
  Then それぞれ終了コード 0 で完了し、ヘルプテキストが表示される
```
