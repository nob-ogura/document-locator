# フェーズ9 運用ドキュメント整備 — タスクと受入基準

> 前提: フェーズ1–8で実装済みの crawler / search が存在し、Design.md の運用・ログ設計と Plan.md の Phase9 で求める内容を反映する。

## タスク一覧
- T1: .env テンプレートと必須/任意変数の説明を README（または同等の運用ドキュメント）に追記し、開発用/本番相当用の切り替え手順を明記する
- T2: 日常運用コマンド集とログ出力例（crawler full/diff、search 代表例、`--limit` 付きスモーク用）を README に掲載する
- T3: 定期実行のセットアップ手順を記載する（cron/launchd サンプル、10分間隔 diff 例、ログ出力先・ローテーション方針）
- T4: トラブルシュート節を追加する（認可エラー、429/5xx リトライ多発、Supabase 5xx/重複エラー時の確認・復旧手順を含む）
- T5: スモークテスト/検証手順への導線を置き、docs/tasks/Phase_smoke.md の参照場所と実行頻度・成功判定を README からたどれるようにする

## 受入基準（Gherkin）

### T1: .env テンプレートと切り替え手順
```gherkin
Scenario: 必須環境変数のセットアップが README だけで完結する
  Given README に必須/任意の環境変数一覧とサンプル値が記載されている
  And 開発用 .env.development と本番相当 .env.production の切り替え手順が説明されている
  When 新規開発者が README を参照して .env を作成する
  Then 必須変数の欠落がなく crawler/search が起動エラーを出さずに開始できる
```

### T2: 運用コマンド集とログ例
```gherkin
Scenario: 日常運用で実行するコマンドとログ例が確認できる
  Given README に crawler の full/diff 実行例、search の代表例、スモーク用途の --limit 例が載っている
  And ログ出力例に INFO サマリと DEBUG の例が 1 行ずつ掲載されている
  When オペレーターが README のコマンドをコピーして実行する
  Then 想定どおりの引数で CLI が動作し、例示されたログ形式で出力される
```

### T3: 定期実行セットアップ
```gherkin
Scenario: 10分間隔で diff モードを走らせるスケジュールが設定できる
  Given README に cron (macOS) または launchd のサンプルエントリが記載されている
  And ログ出力先とローテーション方針が明示されている
  When オペレーターがサンプルをコピーして crontab に登録する
  Then 10分間隔で `pnpm crawler --mode=diff` が実行され、指定先にログが追記される
```

### T4: トラブルシュート
```gherkin
Scenario: 代表的な障害に対する確認ポイントと復旧手順がまとまっている
  Given README のトラブルシュート節に "認可エラー", "429/5xx 多発", "Supabase 5xx/重複" の小見出しがある
  And 各項目にログの確認箇所と再実行/リトライ/キー再発行などの手順が記載されている
  When 障害発生時にオペレーターが該当項目を参照する
  Then 必要なコマンドとチェック項目が 1 ページ内で把握でき、解消またはエスカレーション判断ができる
```

### T5: スモークテスト導線
```gherkin
Scenario: README からスモーク手順に辿れる
  Given README に docs/tasks/Phase_smoke.md へのリンクと実行頻度（フェーズ6後半・7前半で各1回、週1夜間CI）と成功条件が要約されている
  When オペレーターが README の記載をたどる
  Then スモーク実行手順・成功判定・後処理を Phase_smoke.md で確認できる
```
