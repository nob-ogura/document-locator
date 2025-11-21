# OpenAI 実鍵スモーク / モック切替ランブック (Phase 5 / T5)

## ゴール
- summarizeText / extractKeywords / generateEmbedding を実鍵で 1 回だけ叩き、形状と token 使用量ログを確認する。
- CI では常にモック応答に切り替わり、実鍵なしでも安全に通ることを確認する。

## 前提
- リポジトリ直下で実行する。
- `pnpm install` 済み。
- Drive API には触れない（本スクリプトは OpenAI のみ使用）。

## 実鍵スモーク (手動のみ)
1. `.env.production` に `OPENAI_API_KEY` を設定する。その他の値はダミーでもよい。
2. `CI=false` を確認する（未設定であれば false とみなされる）。
3. コマンドを実行: `pnpm dlx tsx scripts/smoke-openai.ts --env=.env.production`
4. 期待結果:
   - ログに `openai smoke start` が出力され、mode=live となる。
   - `summarizeText / extractKeywords / generateEmbedding` が各 1 回成功し、標準出力に summary / keywords / embedding dimensions(1536) が表示される。
   - DEBUG ログに `openai usage` が出力され token 使用量が確認できる。
   - スクリプト終了コードが 0。429/5xx が発生した場合は 1s→2s→4s→8s→16s のバックオフが適用される。

## CI / 実鍵なしでの動作
- `CI=true` をセットすると自動でモックモードに切替わる。
- 実鍵やネットワークが無くても `scripts/smoke-openai.ts` は成功し、ログに `mock openai mode enabled` / `mock openai chat` / `mock openai embeddings` が出る。
- モック応答でも summarizeText / extractKeywords / generateEmbedding が 3–5 件のキーワードと 1536 次元ベクトルを返す。

## トラブルシュート
- `OPENAI_API_KEY is required` が出た場合: `.env.production` にキーが入っているか確認。CI を false にする。
- 429/5xx が続く場合: 再試行待機を踏まえて数分置いてからもう一度。連続実行は避ける。
