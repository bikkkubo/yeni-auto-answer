-- Enable the pg_trgm extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Drop the previously created 'simple' FTS index (if it exists)
DROP INDEX IF EXISTS idx_faq_chunks_content_fts;

-- Create a GIN index on faq_chunks.content using pg_trgm for fuzzy string matching
-- Use IF NOT EXISTS to make the command idempotent
CREATE INDEX IF NOT EXISTS idx_faq_chunks_content_trgm ON faq_chunks USING gin (content extensions.gin_trgm_ops);
