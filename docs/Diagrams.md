# Document Locator - アーキテクチャ図

このドキュメントでは、クローラーおよび検索処理のフローを Mermaid 記法で可視化しています。

---

## 1. システム全体構成

```mermaid
flowchart TB
    subgraph External["外部サービス"]
        GD[("Google Drive")]
        OAI[("OpenAI API")]
        SB[("Supabase / PostgreSQL")]
    end

    subgraph CLI["CLI エントリポイント"]
        CC["crawler.ts"]
        SC["search.ts"]
    end

    subgraph Core["コアモジュール"]
        CR["crawler.ts"]
        SR["search.ts"]
        DR["drive.ts"]
        TX["text_extraction.ts"]
        AI["openai.ts"]
    end

    subgraph Repository["リポジトリ層"]
        DFI["drive_file_index_repository.ts"]
        DSS["drive_sync_state_repository.ts"]
    end

    subgraph Clients["クライアント層"]
        CL["clients.ts"]
    end

    CC --> CR
    SC --> SR
    CR --> DR
    CR --> TX
    CR --> AI
    CR --> DFI
    CR --> DSS
    SR --> AI
    SR --> DFI
    DR --> CL
    TX --> CL
    AI --> CL
    DFI --> CL
    DSS --> CL
    CL --> GD
    CL --> OAI
    CL --> SB
```

---

## 2. クローラー処理フロー

### 2.1 クローラー全体フロー

```mermaid
flowchart TD
    Start([CLI 起動]) --> LoadEnv["環境変数読み込み<br/>(loadEnv)"]
    LoadEnv --> ParseArgs["引数パース<br/>--mode, --limit"]
    ParseArgs --> CreateClients["クライアント初期化<br/>(Google Drive, Supabase, OpenAI)"]
    CreateClients --> SyncIndex["syncSupabaseIndex 呼び出し"]

    subgraph SyncProcess["同期処理"]
        SyncIndex --> EnumFiles["enumerateDriveFiles"]
        EnumFiles --> ResolveMode["クロールモード解決"]
        ResolveMode -->|auto/diff| CheckSync["drive_sync_state 確認"]
        ResolveMode -->|full| FullCrawl["フルクロール"]
        CheckSync -->|state あり| DiffCrawl["差分クロール"]
        CheckSync -->|state なし| FullCrawl
        DiffCrawl --> ListFiles["Drive files.list<br/>(modifiedTime フィルタ)"]
        FullCrawl --> ListFilesAll["Drive files.list<br/>(全件取得)"]
        ListFiles --> FilterMime["MIME タイプフィルタ"]
        ListFilesAll --> FilterMime
        FilterMime --> ApplyLimit["limit 適用"]
    end

    ApplyLimit --> ProcessFiles["並列ファイル処理<br/>(最大5並列)"]

    subgraph FileProcess["ファイル処理ループ"]
        ProcessFiles --> ExtractText["テキスト抽出"]
        ExtractText --> AIPipeline["AI パイプライン"]
        AIPipeline --> Upsert["Supabase upsert"]
        Upsert --> UpdateSync["sync_state 更新"]
    end

    UpdateSync --> LogSummary["サマリーログ出力"]
    LogSummary --> End([終了])

    style Start fill:#e1f5fe
    style End fill:#e8f5e9
    style SyncProcess fill:#fff3e0
    style FileProcess fill:#fce4ec
```

### 2.2 クロールモード解決フロー

```mermaid
flowchart TD
    Input["requestedMode"] --> CheckMode{モード判定}

    CheckMode -->|full| ReturnFull["effectiveMode = full<br/>driveQuery = undefined"]

    CheckMode -->|diff| CheckDiffSync{"drive_sync_state<br/>存在確認"}
    CheckDiffSync -->|あり| ReturnDiff["effectiveMode = diff<br/>driveQuery = modifiedTime > 'timestamp'"]
    CheckDiffSync -->|なし| FallbackFull["effectiveMode = full<br/>(フォールバック)"]

    CheckMode -->|auto| CheckAutoSync{"drive_sync_state<br/>存在確認"}
    CheckAutoSync -->|あり| ReturnDiffAuto["effectiveMode = diff"]
    CheckAutoSync -->|なし| ReturnFullAuto["effectiveMode = full"]

    ReturnFull --> Output["CrawlContext 返却"]
    ReturnDiff --> Output
    FallbackFull --> Output
    ReturnDiffAuto --> Output
    ReturnFullAuto --> Output

    style Input fill:#e3f2fd
    style Output fill:#e8f5e9
```

### 2.3 AI パイプライン詳細

```mermaid
flowchart TD
    FileEntry["DriveFileEntry"] --> ExtractText["extractTextOrSkip"]

    subgraph TextExtraction["テキスト抽出"]
        ExtractText --> CheckMime{MIME タイプ判定}
        CheckMime -->|Google Doc| ExportPlain["files.export<br/>(text/plain)"]
        CheckMime -->|Google Sheets| ExportCSV["files.export<br/>(text/csv)"]
        CheckMime -->|PDF| GetPDF["files.get → pdf-parse"]
        CheckMime -->|DOCX| GetDocx["files.get → mammoth"]
        CheckMime -->|plain/md/csv| GetText["files.get<br/>(バイナリ → UTF-8)"]
        CheckMime -->|未対応| Skip["null 返却 (スキップ)"]
    end

    ExportPlain --> RawText["抽出テキスト"]
    ExportCSV --> RawText
    GetPDF --> RawText
    GetDocx --> RawText
    GetText --> RawText

    RawText --> CheckEmpty{テキスト空?}
    CheckEmpty -->|はい| SkipAI["AI 処理スキップ"]
    CheckEmpty -->|いいえ| Summarize["summarizeText<br/>(gpt-4o-mini)"]

    Summarize --> Keywords["extractKeywords<br/>(gpt-4o-mini)"]
    Keywords --> BuildInput["buildEmbeddingInput<br/>(要約 + キーワード + ファイル名)"]
    BuildInput --> Embedding["generateEmbedding<br/>(text-embedding-3-small)"]
    Embedding --> ProcessedFile["AiProcessedDriveFile"]

    SkipAI --> ProcessedFile

    style FileEntry fill:#e3f2fd
    style ProcessedFile fill:#e8f5e9
    style TextExtraction fill:#fff3e0
```

### 2.4 Drive ファイル列挙 (Paging)

```mermaid
flowchart TD
    Start["listDriveFilesPaged"] --> InitQueue["フォルダキュー初期化<br/>(targetFolderIds)"]
    InitQueue --> LoopFolder{フォルダ残り?}

    LoopFolder -->|はい| PopFolder["フォルダ ID 取得"]
    PopFolder --> ListPage["files.list<br/>(pageSize=100)"]
    ListPage --> ParseResponse["レスポンス解析"]

    ParseResponse --> CheckFolder{サブフォルダ?}
    CheckFolder -->|はい| AddQueue["キューに追加"]
    CheckFolder -->|いいえ| Continue

    AddQueue --> Continue["ファイルを aggregated に追加"]
    Continue --> CheckPageToken{nextPageToken?}
    CheckPageToken -->|あり| ListPage
    CheckPageToken -->|なし| LoopFolder

    LoopFolder -->|いいえ| FilterSync["filterBySyncState<br/>(diff モード時)"]
    FilterSync --> Return["DriveFileEntry[] 返却"]

    style Start fill:#e3f2fd
    style Return fill:#e8f5e9
```

---

## 3. 検索処理フロー

### 3.1 検索全体フロー

```mermaid
flowchart TD
    Start([CLI 起動]) --> LoadEnv["環境変数読み込み"]
    LoadEnv --> ParseQuery["クエリ・フィルタ解析<br/>(--after, --before, --mime, --similarity)"]
    ParseQuery --> BuildRequest["SearchRequest 構築"]
    BuildRequest --> RunSearch["runSearchWithRanking"]

    subgraph SearchLoop["検索ループ"]
        RunSearch --> ExtractKW["extractKeywords<br/>(クエリからキーワード抽出)"]
        ExtractKW --> VectorSearch["performVectorSearchRound"]
        VectorSearch --> ClassifyHits["ヒット数分類<br/>(none/single/few/mid/tooMany)"]

        ClassifyHits --> BucketDecision{バケット判定}

        BucketDecision -->|none| TryRelax["閾値緩和を試行"]
        TryRelax --> ContinueOrEnd{継続?}
        ContinueOrEnd -->|はい| VectorSearch
        ContinueOrEnd -->|いいえ| EmptyResult["空結果返却"]

        BucketDecision -->|single| SingleResult["1件返却"]

        BucketDecision -->|few| Rerank["rerankResultsWithLLM<br/>(gpt-4o-mini)"]
        Rerank --> FewResult["リランク結果返却"]

        BucketDecision -->|mid| FilterMedium["similarity >= 0.5<br/>でフィルタ"]
        FilterMedium --> MidResult["最大10件返却"]

        BucketDecision -->|tooMany| AskUser{"ユーザーに<br/>絞り込み質問"}
        AskUser -->|回答あり| RefineQuery["クエリ拡張"]
        RefineQuery --> ExtractKW
        AskUser -->|回答なし/上限| TooManyResult["上位10件返却"]
    end

    EmptyResult --> FormatOutput["結果フォーマット"]
    SingleResult --> FormatOutput
    FewResult --> FormatOutput
    MidResult --> FormatOutput
    TooManyResult --> FormatOutput

    FormatOutput --> PrintResult["コンソール出力"]
    PrintResult --> End([終了])

    style Start fill:#e1f5fe
    style End fill:#e8f5e9
    style SearchLoop fill:#f3e5f5
```

### 3.2 ベクトル検索ラウンド詳細

```mermaid
flowchart TD
    Input["query, keywords, filters"] --> BuildEmbedding["buildQueryEmbeddingText<br/>(query + keywords)"]
    BuildEmbedding --> GenEmbed["generateEmbedding<br/>(text-embedding-3-small)"]
    GenEmbed --> PrepareQuery["lexicalQueryText 準備<br/>(keywords or query)"]

    PrepareQuery --> CallRPC["vectorSearchDriveFileIndex<br/>(match_drive_file_index RPC)"]

    subgraph RPCCall["Supabase RPC"]
        CallRPC --> HybridSearch["ハイブリッド検索<br/>(vector + lexical)"]
        HybridSearch --> ApplyFilters["フィルタ適用<br/>(after/before/mime)"]
        ApplyFilters --> ScoreCalc["スコア計算<br/>(hybrid_score)"]
    end

    ScoreCalc --> ResolveSim["resolveSimilarity<br/>(similarity/distance/hybrid)"]
    ResolveSim --> FilterThreshold["閾値フィルタ<br/>(similarityThreshold)"]
    FilterThreshold --> CalcTop["topSimilarity 計算"]
    CalcTop --> Return["filtered, all, topSimilarity"]

    style Input fill:#e3f2fd
    style Return fill:#e8f5e9
    style RPCCall fill:#fff8e1
```

### 3.3 ヒット数バケット分類

```mermaid
flowchart LR
    HitCount["hitCount"] --> Check{件数}

    Check -->|0| None["none"]
    Check -->|1| Single["single"]
    Check -->|2-9| Few["few"]
    Check -->|10-49| Mid["mid"]
    Check -->|50+| TooMany["tooMany"]

    None --> ActionNone["閾値緩和 or 終了"]
    Single --> ActionSingle["そのまま返却"]
    Few --> ActionFew["LLM リランク"]
    Mid --> ActionMid["similarity >= 0.5 フィルタ"]
    TooMany --> ActionTooMany["ユーザーに絞り込み依頼"]

    style None fill:#ffcdd2
    style Single fill:#c8e6c9
    style Few fill:#c8e6c9
    style Mid fill:#fff9c4
    style TooMany fill:#ffcdd2
```

### 3.4 LLM リランク処理

```mermaid
flowchart TD
    Candidates["候補ドキュメント<br/>(few バケット)"] --> BuildPrompt["プロンプト構築<br/>(file_name, summary, keywords)"]

    BuildPrompt --> CallLLM["gpt-4o-mini 呼び出し<br/>(temperature=0)"]

    subgraph LLMRerank["LLM リランク"]
        CallLLM --> ParseJSON["JSON 配列パース<br/>(file_id リスト)"]
        ParseJSON --> CheckValid{有効なID?}
        CheckValid -->|はい| Reorder["候補を並び替え"]
        CheckValid -->|いいえ| Fallback["元の順序を維持"]
    end

    Reorder --> LexicalBoost["Lexical ブースト<br/>(クエリ文字列一致)"]
    Fallback --> LexicalBoost
    LexicalBoost --> Slice["上位10件にスライス"]
    Slice --> Return["リランク結果"]

    style Candidates fill:#e3f2fd
    style Return fill:#e8f5e9
    style LLMRerank fill:#f3e5f5
```

---

## 4. データフロー図

### 4.1 クローラーのデータフロー

```mermaid
flowchart LR
    subgraph Input["入力"]
        CLI["CLI 引数<br/>(mode, limit)"]
        ENV["環境変数<br/>(API キー等)"]
    end

    subgraph GoogleDrive["Google Drive"]
        Files["ファイル一覧"]
        Content["ファイルコンテンツ"]
    end

    subgraph Processing["処理"]
        Extract["テキスト抽出"]
        Summarize["要約生成"]
        Keywords["キーワード抽出"]
        Embed["埋め込み生成"]
    end

    subgraph Storage["永続化"]
        FileIndex[("drive_file_index<br/>(file_id, summary, embedding, ...)")]
        SyncState[("drive_sync_state<br/>(drive_modified_at)")]
    end

    CLI --> Processing
    ENV --> Processing
    Files --> Extract
    Content --> Extract
    Extract --> Summarize
    Summarize --> Keywords
    Keywords --> Embed
    Embed --> FileIndex
    FileIndex --> SyncState
```

### 4.2 検索のデータフロー

```mermaid
flowchart LR
    subgraph Input["入力"]
        Query["検索クエリ"]
        Filters["フィルタ<br/>(after/before/mime)"]
    end

    subgraph Processing["処理"]
        KWExtract["キーワード抽出"]
        QueryEmbed["クエリ埋め込み"]
        VecSearch["ベクトル検索"]
        Rerank["LLM リランク"]
    end

    subgraph Storage["ストレージ"]
        FileIndex[("drive_file_index")]
    end

    subgraph Output["出力"]
        Results["検索結果<br/>(file_name, summary, link)"]
    end

    Query --> KWExtract
    KWExtract --> QueryEmbed
    QueryEmbed --> VecSearch
    Filters --> VecSearch
    FileIndex --> VecSearch
    VecSearch --> Rerank
    Rerank --> Results
```

---

## 5. シーケンス図

### 5.1 クローラー実行シーケンス

```mermaid
sequenceDiagram
    participant CLI as CLI
    participant Crawler as Crawler
    participant Drive as Google Drive
    participant OpenAI as OpenAI
    participant Supabase as Supabase

    CLI->>Crawler: syncSupabaseIndex(config, mode, limit)
    Crawler->>Supabase: getDriveSyncState()
    Supabase-->>Crawler: syncState | null

    Crawler->>Crawler: resolveCrawlContext(mode, syncState)

    Crawler->>Drive: folders.ensureTargetsExist()
    Drive-->>Crawler: OK

    loop フォルダごと
        Crawler->>Drive: files.list(q, pageSize, pageToken)
        Drive-->>Crawler: files[], nextPageToken
    end

    Crawler->>Crawler: filterByMime, applyLimit

    par 並列処理 (max 5)
        Crawler->>Drive: files.export | files.get
        Drive-->>Crawler: content

        Crawler->>OpenAI: summarizeText(text)
        OpenAI-->>Crawler: summary

        Crawler->>OpenAI: extractKeywords(text)
        OpenAI-->>Crawler: keywords[]

        Crawler->>OpenAI: generateEmbedding(input)
        OpenAI-->>Crawler: embedding[]

        Crawler->>Supabase: upsertDriveFileIndexOne(row)
        Supabase-->>Crawler: OK

        Crawler->>Supabase: upsertDriveSyncState(modifiedAt)
        Supabase-->>Crawler: OK
    end

    Crawler->>CLI: SyncSupabaseResult
```

### 5.2 検索実行シーケンス

```mermaid
sequenceDiagram
    participant CLI as CLI
    participant Search as Search
    participant OpenAI as OpenAI
    participant Supabase as Supabase
    participant User as User (optional)

    CLI->>Search: runSearchWithRanking(request)

    loop 検索ループ (max N回)
        Search->>OpenAI: extractKeywords(query)
        OpenAI-->>Search: keywords[]

        Search->>OpenAI: generateEmbedding(queryText)
        OpenAI-->>Search: embedding[]

        Search->>Supabase: match_drive_file_index(embedding, filters)
        Supabase-->>Search: rows[]

        Search->>Search: classifyHitCount(filtered.length)

        alt bucket = tooMany
            Search->>User: askUser(refinement question)
            User-->>Search: additional keywords
            Search->>Search: update query
        else bucket = few
            Search->>OpenAI: rerankResultsWithLLM(candidates)
            OpenAI-->>Search: ranked file_ids[]
        else bucket = single | mid | none
            Search->>Search: finalize results
        end
    end

    Search->>CLI: SearchOutcome
```

---

## 6. 状態遷移図

### 6.1 検索バケット状態遷移

```mermaid
stateDiagram-v2
    [*] --> VectorSearch: 検索開始

    VectorSearch --> none: hitCount = 0
    VectorSearch --> single: hitCount = 1
    VectorSearch --> few: hitCount = 2-9
    VectorSearch --> mid: hitCount = 10-49
    VectorSearch --> tooMany: hitCount >= 50

    none --> VectorSearch: 閾値緩和
    none --> [*]: 終了 (空結果)

    single --> [*]: 終了 (1件)

    few --> Rerank: LLM リランク
    Rerank --> [*]: 終了

    mid --> [*]: 終了 (フィルタ済み)

    tooMany --> AskUser: ユーザー質問
    AskUser --> VectorSearch: クエリ拡張
    AskUser --> [*]: 終了 (上位10件)
```

### 6.2 クロールモード状態遷移

```mermaid
stateDiagram-v2
    [*] --> CheckMode: モード指定

    CheckMode --> Full: mode = full
    CheckMode --> CheckSync: mode = diff | auto

    CheckSync --> Diff: syncState あり
    CheckSync --> Full: syncState なし

    Full --> ListAll: 全件取得
    Diff --> ListDiff: 差分取得

    ListAll --> Process: ファイル処理
    ListDiff --> Process

    Process --> UpdateSync: 同期完了
    UpdateSync --> [*]
```

---

## 7. コンポーネント依存関係

```mermaid
graph TD
    subgraph CLI["CLI Layer"]
        CrawlerCLI["cli/crawler.ts"]
        SearchCLI["cli/search.ts"]
    end

    subgraph Domain["Domain Layer"]
        Crawler["crawler.ts"]
        Search["search.ts"]
        Drive["drive.ts"]
        TextExtract["text_extraction.ts"]
        OpenAI["openai.ts"]
        Mime["mime.ts"]
        Time["time.ts"]
    end

    subgraph Repository["Repository Layer"]
        FileIndexRepo["drive_file_index_repository.ts"]
        SyncStateRepo["drive_sync_state_repository.ts"]
    end

    subgraph Infrastructure["Infrastructure Layer"]
        Clients["clients.ts"]
        HTTP["http.ts"]
        Logger["logger.ts"]
        Env["env.ts"]
    end

    CrawlerCLI --> Crawler
    CrawlerCLI --> Env
    CrawlerCLI --> Logger

    SearchCLI --> Search
    SearchCLI --> Env
    SearchCLI --> Logger

    Crawler --> Drive
    Crawler --> TextExtract
    Crawler --> OpenAI
    Crawler --> FileIndexRepo
    Crawler --> SyncStateRepo
    Crawler --> Mime
    Crawler --> Time

    Search --> OpenAI
    Search --> FileIndexRepo

    Drive --> Clients
    Drive --> SyncStateRepo
    Drive --> HTTP
    Drive --> Time

    TextExtract --> Clients

    OpenAI --> Clients

    FileIndexRepo --> Clients
    SyncStateRepo --> Clients

    Clients --> HTTP
    Clients --> Logger
    Clients --> Env
```

