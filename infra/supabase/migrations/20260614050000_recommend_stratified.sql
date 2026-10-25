-- ============================================================================
-- recommend_for_user — stratified random sampling for genuine refresh variety
--
-- Previous version added a tiny (~±0.005) jitter to cosine distance, but for
-- users with concentrated taste vectors the top items cluster within 0.02
-- of each other, so jitter only ever shuffles the very top 5-6 positions.
-- User reports: "the For You card stays the same most of the time."
--
-- New strategy:
--   1. Fetch top 300 candidates by similarity, dedupe by file_path.
--   2. Always include the top 20 (the "must-show" tier — user's strongest
--      taste matches are guaranteed to appear).
--   3. Random-sample the remainder from positions 20-300 by similarity rank
--      (the "discovery" tier — taste-relevant but not strictly the closest).
--   4. Final shuffle so the order changes on every call.
--
-- Each refresh therefore produces a different mix while always feeling
-- personally relevant. Category cap unchanged.
-- ============================================================================

drop function if exists public.recommend_for_user(uuid, integer);

create or replace function public.recommend_for_user(
  p_user_id uuid,
  p_count integer default 30
) returns table (
  id bigint,
  file_path text,
  category text,
  similarity real
)
language plpgsql
-- volatile (default) — uses random()
security definer
set search_path = public
as $$
declare
  v_taste vector(768);
  v_cat_cap integer;
  v_core_size integer;
  v_pool_size integer;
begin
  if p_user_id is null then return; end if;

  select t.vector into v_taste
  from public.user_taste t
  where t.user_id = p_user_id
  limit 1;
  if v_taste is null then return; end if;

  v_cat_cap   := greatest(8, p_count / 2);
  -- "must-show" tier: always include top 20 (or 1/3 of requested count).
  v_core_size := least(p_count, greatest(20, p_count / 3));
  -- Candidate pool we sample from: ~5x p_count
  v_pool_size := greatest(200, p_count * 5);

  return query
  with candidates as (
    select
      w.id,
      w.file_path,
      w.category,
      (1 - (w.embedding <=> v_taste))::real as similarity,
      (w.embedding <=> v_taste) as distance
    from public.wallpapers w
    where w.embedding is not null
    order by w.embedding <=> v_taste
    limit v_pool_size
  ),
  deduped as (
    select distinct on (c.file_path)
      c.id, c.file_path, c.category, c.similarity, c.distance
    from candidates c
    order by c.file_path, c.distance
  ),
  ordered as (
    select d.*, row_number() over (order by d.distance) as sim_rank
    from deduped d
  ),
  -- Always-show tier
  core as (
    select * from ordered where sim_rank <= v_core_size
  ),
  -- Discovery tier: random sample from the rest of the candidate pool
  fringe as (
    select * from ordered
    where sim_rank > v_core_size
    order by random()
    limit greatest(0, p_count - v_core_size)
  ),
  combined as (
    select * from core
    union all
    select * from fringe
  ),
  ranked as (
    select
      c.*,
      row_number() over (partition by c.category order by c.distance) as rank_in_cat
    from combined c
  )
  select r.id, r.file_path, r.category, r.similarity
  from ranked r
  where r.rank_in_cat <= v_cat_cap
  order by random()  -- final shuffle — the For You row never opens the same
  limit greatest(1, least(p_count, 100));
end;
$$;

grant execute on function public.recommend_for_user(uuid, integer) to authenticated;
