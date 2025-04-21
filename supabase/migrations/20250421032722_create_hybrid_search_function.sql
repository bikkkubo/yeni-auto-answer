-- ハイブリッド検索を実行するRPC関数
create or replace function hybrid_search_faq_chunks (
  query_embedding vector(1536),      -- 検索クエリのベクトル
  query_text text,                  -- 検索クエリのテキスト (pg_trgm用)
  match_threshold_vector float,     -- ベクトル類似度の閾値 (例: 0.7)
  match_threshold_trigram float,    -- pg_trgm類似度の閾値 (例: 0.1 や 0.2 など低めに設定)
  match_count int,                  -- 返す最大件数
  weight_vector float,              -- ベクトルスコアの重み (例: 0.6)
  weight_trigram float              -- pg_trgmスコアの重み (例: 0.4)
)
returns table (
  id uuid,                          -- チャンクID
  question text,                    -- 元の質問
  content text,                     -- チャンクの内容
  similarity_vector float,          -- ベクトル検索の類似度スコア (0-1)
  similarity_trigram float,         -- pg_trgmの類似度スコア (0-1)
  final_score float                 -- 統合スコア
)
language sql stable
as $$
  -- CTEでベクトル検索とトライグラム検索の候補をそれぞれ取得し、スコアを計算
  with vector_matches as (
    select
      id,
      question,
      content,
      1 - (embedding <=> query_embedding) as similarity_vector -- コサイン類似度 (0-1)
    from faq_chunks
    where 1 - (embedding <=> query_embedding) > match_threshold_vector
    order by similarity_vector desc
    limit match_count * 2 -- 最終結果の候補を多めに取得
  ),
  trigram_matches as (
    select
      id,
      question,
      content,
      similarity(content, query_text) as similarity_trigram -- pg_trgm類似度 (0-1)
    from faq_chunks
    where similarity(content, query_text) > match_threshold_trigram
    order by similarity_trigram desc
    limit match_count * 2 -- 最終結果の候補を多めに取得
  ),
  -- 両方の検索結果を結合し、重複を除去 (UNION は DISTINCT がデフォルト)
  combined_matches as (
    select id, question, content from vector_matches
    union
    select id, question, content from trigram_matches
  )
  -- 結合した結果に対して、最終スコアを計算しランキング
  select
    cm.id,
    cm.question,
    cm.content,
    coalesce(vm.similarity_vector, 0.0) as similarity_vector, -- マッチしなかった場合はスコア0
    coalesce(tm.similarity_trigram, 0.0) as similarity_trigram, -- マッチしなかった場合はスコア0
    -- 重み付けして最終スコアを計算
    (coalesce(vm.similarity_vector, 0.0) * weight_vector) + (coalesce(tm.similarity_trigram, 0.0) * weight_trigram) as final_score
  from combined_matches cm
  -- 各スコアを取得するために元のCTEにLEFT JOIN
  left join vector_matches vm on cm.id = vm.id
  left join trigram_matches tm on cm.id = tm.id
  -- 最終スコアで降順に並び替え
  order by final_score desc
  -- 指定された件数を返す
  limit match_count;
$$;
