-- ============================================================================
-- Add small random jitter so pull-to-refresh shuffles the feed within the
-- same similarity tier. Without this, the RPC is deterministic — same taste
-- vector + same DB returns the same ordered list every call, so the user
-- sees no change unless their taste vector actually updates between pulls.
--
-- jitter range: ~±0.005 in cosine-distance space. The user's top candidates
-- typically cluster within 0.05 of each other, so the jitter is large enough
-- to noticeably shuffle them but small enough not to surface anything outside
-- their top-similar pool.
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
-- volatile (default) because we use random(); stable was wrong before — would
-- have let the planner memoize the result across calls within a transaction.
security definer
set search_path = public
as $$
declare
  v_taste vector(768);
  v_cat_cap integer;
begin
  if p_user_id is null then return; end if;

  select t.vector into v_taste
  from public.user_taste t
  where t.user_id = p_user_id
  limit 1;
  if v_taste is null then return; end if;

  v_cat_cap := greatest(8, p_count / 2);

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
    limit greatest(200, p_count * 8)
  ),
  deduped as (
    select distinct on (c.file_path)
      c.id, c.file_path, c.category, c.similarity, c.distance
    from candidates c
    order by c.file_path, c.distance
  ),
  ranked as (
    select
      d.*,
      row_number() over (
        partition by d.category
        order by d.distance + (random() * 0.005)
      ) as rank_in_cat
    from deduped d
  )
  select r.id, r.file_path, r.category, r.similarity
  from ranked r
  where r.rank_in_cat <= v_cat_cap
  order by r.distance + (random() * 0.005)
  limit greatest(1, least(p_count, 100));
end;
$$;

grant execute on function public.recommend_for_user(uuid, integer) to authenticated;
