# Test fixtures

- Purpose: share Drive/OpenAI/Supabase mocks between e2e-ish tests to keep expectations aligned.
- Files:
  - `drive.ts` — canned Drive file lists and `createDriveMock`.
  - `openai.ts` — `createOpenAIMock` that handles keyword extraction, summaries, relaxation, and rerank prompts.
  - `supabase.ts` — `createSupabaseIndexMock` for crawler upserts and `createSupabaseSearchMock` for search/vector calls.
- Update flow: add/adjust fixture data here first, then point new tests to these helpers instead of inlining mocks. Run `pnpm test -- --filter crawler-e2e` and `pnpm test -- --filter search-e2e` to confirm call counts still match.
