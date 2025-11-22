-- RPC for vector similarity search with optional filters
CREATE OR REPLACE FUNCTION match_drive_file_index(
  query_embedding VECTOR(1536),
  match_count INTEGER DEFAULT 20,
  probes INTEGER DEFAULT 10,
  filter_file_ids TEXT[] DEFAULT NULL,
  filter_after TIMESTAMPTZ DEFAULT NULL,
  filter_before TIMESTAMPTZ DEFAULT NULL,
  filter_mime TEXT DEFAULT NULL
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
  similarity DOUBLE PRECISION
) AS $$
BEGIN
  -- Tune ivfflat search quality per request
  PERFORM set_config('ivfflat.probes', probes::TEXT, true);

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
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM drive_file_index AS d
  WHERE (filter_file_ids IS NULL OR d.file_id = ANY (filter_file_ids))
    AND (filter_after IS NULL OR d.drive_modified_at >= filter_after)
    AND (filter_before IS NULL OR d.drive_modified_at <= filter_before)
    AND (filter_mime IS NULL OR d.mime_type = filter_mime)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql VOLATILE;
