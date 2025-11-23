-- Replace vec_similarity call with portable cosine-based similarity
DROP FUNCTION IF EXISTS match_drive_file_index(
  query_embedding VECTOR(1536),
  match_count INTEGER,
  probes INTEGER,
  filter_file_ids TEXT[],
  filter_after TIMESTAMPTZ,
  filter_before TIMESTAMPTZ,
  filter_mime TEXT,
  query_text TEXT
);

CREATE OR REPLACE FUNCTION match_drive_file_index(
  query_embedding VECTOR(1536),
  match_count INTEGER DEFAULT 20,
  probes INTEGER DEFAULT 10,
  filter_file_ids TEXT[] DEFAULT NULL,
  filter_after TIMESTAMPTZ DEFAULT NULL,
  filter_before TIMESTAMPTZ DEFAULT NULL,
  filter_mime TEXT DEFAULT NULL,
  query_text TEXT DEFAULT NULL
)
RETURNS TABLE (
  file_id TEXT,
  file_name TEXT,
  summary TEXT,
  keywords TEXT[],
  drive_modified_at TIMESTAMPTZ,
  mime_type TEXT,
  embedding VECTOR(1536),
  distance DOUBLE PRECISION,
  similarity DOUBLE PRECISION,
  lexical DOUBLE PRECISION,
  hybrid_score DOUBLE PRECISION
) AS $$
DECLARE
  ts_query TSQUERY;
BEGIN
  PERFORM set_config('ivfflat.probes', probes::TEXT, true);

  IF query_text IS NOT NULL AND length(trim(query_text)) > 0 THEN
    ts_query := websearch_to_tsquery('simple', query_text);
  ELSE
    ts_query := NULL;
  END IF;

  RETURN QUERY
  SELECT
    d.file_id,
    d.file_name,
    d.summary,
    d.keywords,
    d.drive_modified_at,
    d.mime_type,
    d.embedding,
    d.embedding <=> query_embedding AS distance,
    1 - (d.embedding <=> query_embedding) AS similarity,
    CASE
      WHEN ts_query IS NULL THEN 0
      ELSE ts_rank_cd(d.file_name_tsv, ts_query)
    END AS lexical,
    (0.7 * (1 - (d.embedding <=> query_embedding)))
      + (0.3 * CASE
                WHEN ts_query IS NULL THEN 0
                ELSE ts_rank_cd(d.file_name_tsv, ts_query)
              END) AS hybrid_score
  FROM drive_file_index AS d
  WHERE (filter_file_ids IS NULL OR d.file_id = ANY (filter_file_ids))
    AND (filter_after IS NULL OR d.drive_modified_at >= filter_after)
    AND (filter_before IS NULL OR d.drive_modified_at <= filter_before)
    AND (filter_mime IS NULL OR d.mime_type = filter_mime)
  ORDER BY hybrid_score DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql VOLATILE;
