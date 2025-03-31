-- documentsテーブルをリセットし、source_typeカラムを含む新しいスキーマで再作成するSQL

-- 既存のテーブルを削除
DROP TABLE IF EXISTS documents;

-- pgvector拡張が有効になっていることを確認（すでに有効化されている場合は無視されます）
CREATE EXTENSION IF NOT EXISTS vector;

-- 新しいテーブルを作成（source_type カラムを含む）
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,               -- ベクトル検索の対象となるテキスト（FAQ の Answer）
    question TEXT,                       -- FAQ の Question
    source_type TEXT NOT NULL,           -- データのソース種別（'faq' など）
    embedding VECTOR(1536) NOT NULL,     -- OpenAI text-embedding-3-small の次元数
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 作成日時、更新日時のトリガー
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER documents_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- match_documents関数の作成・更新
CREATE OR REPLACE FUNCTION match_documents (
  query_embedding vector(1536), -- OpenAI text-embedding-3-small の次元数
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  question TEXT,
  source_type TEXT,
  similarity float
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    documents.id,
    documents.content,
    documents.question,
    documents.source_type,
    1 - (documents.embedding <=> query_embedding) as similarity -- コサイン類似度 (1 - コサイン距離)
  FROM documents
  WHERE 1 - (documents.embedding <=> query_embedding) > match_threshold
  ORDER BY documents.embedding <=> query_embedding -- コサイン距離が小さい順 (類似度が高い順)
  LIMIT match_count;
$$; 