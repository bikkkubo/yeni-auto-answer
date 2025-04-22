-- Drop potentially conflicting function definitions with specific argument types
DROP FUNCTION IF EXISTS public.hybrid_search_faq_chunks(vector, text, integer, double precision, double precision, double precision, double precision);
DROP FUNCTION IF EXISTS public.hybrid_search_faq_chunks(vector, text, double precision, double precision, integer, double precision, double precision);

-- Recreate the function with the single, correct definition including default values
create or replace function public.hybrid_search_faq_chunks (
  query_embedding vector(1536),
  query_text text,
  match_count integer default 20,          -- Default 値を追加
  match_threshold_vector float default 0.6, -- Default 値を変更 (0.7->0.6)
  match_threshold_trigram float default 0.05, -- Default 値を変更 (0.1->0.05)
  weight_vector float default 0.4,          -- Default 値を変更 (0.6->0.4)
  weight_trigram float default 0.6          -- Default 値を変更 (0.4->0.6)
)
returns table (
  id uuid,
  question text,
  content text,
  similarity_vector float,
  similarity_trigram float,
  final_score float
)
language sql stable
as $$
  -- CTEでベクトル検索とトライグラム検索の候補をそれぞれ取得し、スコアを計算
  with vector_matches as (
    select
      fc.id,
      fc.question,
      fc.content,
      1 - (fc.embedding <=> query_embedding) as similarity_vector
    from public.faq_chunks fc -- Explicitly qualify table name
    where 1 - (fc.embedding <=> query_embedding) > match_threshold_vector
    order by similarity_vector desc
    limit match_count * 2
  ),
  trigram_matches as (
    select
      fc.id,
      fc.question,
      fc.content,
      similarity(fc.content, query_text) as similarity_trigram
    from public.faq_chunks fc -- Explicitly qualify table name
    where similarity(fc.content, query_text) > match_threshold_trigram
    order by similarity_trigram desc
    limit match_count * 2
  ),
  combined_matches as (
    select vm.id, vm.question, vm.content from vector_matches vm
    union
    select tm.id, tm.question, tm.content from trigram_matches tm
  )
  select
    cm.id,
    cm.question,
    cm.content,
    coalesce(vm.similarity_vector, 0.0) as similarity_vector,
    coalesce(tm.similarity_trigram, 0.0) as similarity_trigram,
    (coalesce(vm.similarity_vector, 0.0) * weight_vector) + (coalesce(tm.similarity_trigram, 0.0) * weight_trigram) as final_score
  from combined_matches cm
  left join vector_matches vm on cm.id = vm.id
  left join trigram_matches tm on cm.id = tm.id
  order by final_score desc
  limit match_count;
$$;
