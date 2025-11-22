# フェーズ7 再実装タスク（ベクトル検索起点への書き直し）

> 目的: 既存の Drive 起点検索フローを廃止し、Plan.md 更新後のベクトル検索起点仕様に完全準拠するコードへ書き直す。影響範囲は CLI/検索ロジック/ベクトル検索パラメータ/テスト。

## 実装タスク
- **CLI刷新**: `src/cli/search.ts` で `--similarity`(default 0.70), `--limit`(default 80) を追加し JSON でも出力する。既存の Drive 検索前提ログ/出力文言を新バケット定義に合わせる。
- **検索パイプライン置換**: `src/search.ts` をベクトル検索起点に再構成。キーワード抽出→Embedding→Supabase `match_drive_file_index` で期間/MIME フィルタ、件数・最上位類似度に基づく分岐を実装（50+ または top<0.75 → 質問再検索、10–49 → 上位20→0.75未満除外→必要ならリライト、2–9 → LLM リランキング、1 → 即出力、0 → しきい値0.60まで緩和＋キーワード削減）。
- **パラメータ制御**: ベクトル検索の `match_count` は CLI `--limit` を上限に、`probes` は config/env 既定を流用しつつテストで上書きできるようにする。類似度しきい値 0.82/0.75/0.60 を定数化。
- **Drive 依存の最小化**: Drive API 呼び出しは候補ファイルの存在確認や `modifiedTime` 差分取得に限定し、検索起点では使用しないように削除/切替。
- **結果フォーマット**: 表示件数は最終 10 件以内。要約は `SUMMARY_MAX_LENGTH` でトリム、Drive 直リンク生成を維持。
- **ロギング/バックオフ**: INFO で件数・類似度トップ・分岐/再検索回数、DEBUG でトークン使用量と Supabase 呼び出しを出力。429/5xx は共通指数バックオフを OpenAI/Supabase 双方で適用。

## テストタスク
- **ユニット再設計**: `tests/search_branching.test.ts` を類似度/件数ベースの新バケットに合わせ再作成（0/1/5/35/120 + top<0.75 のケース）。
- **ベクトル検索/リランキング**: `tests/search_ranking_and_vector.test.ts` と `tests/search_e2e.test.ts` を k=limit、しきい値 0.82/0.75/0.60、上位20→10件提示フローに合わせて書き直し。`match_count`/`filter_file_ids` 期待値を更新。
- **CLI パース/出力**: `tests/cli_search.test.ts` に `--similarity` と `--limit` のパース確認、バケット文言/「10 件以下に絞り込めませんでした」「見つかりませんでした」分岐を反映。
- **旧 Drive 起点テスト除去**: `tests/search_initial_drive.test.ts` など Drive 検索前提のテストを削除または新仕様に沿うモックへ置換。
- **Fixtures 更新**: `tests/fixtures/supabase.ts` の `match_drive_file_index` モックで `match_count`=limit、類似度ダミー値、`probes` を受け取れるよう変更。必要なら Drive fixture から検索依存コードを削減。

## 移行と検証
- **段階反映**: CLI → 検索ロジック → リポジトリ → テストの順にコミット。各ステップで `pnpm test -- --filter search` を実行。
- **スモークチェック**: モック環境で `pnpm search "demo" --limit 15 --similarity 0.72` を走らせ、バケット別ログと出力件数を確認。
