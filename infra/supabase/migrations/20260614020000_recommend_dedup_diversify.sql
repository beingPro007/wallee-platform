-- ============================================================================
-- recommend_for_user — deduplicate + diversify
--
-- Two problems observed in production:
--   1. wallpapers table has occasional duplicate file_path rows (multiple ids
--      pointing to the same image), so the same wallpaper could appear twice
--      in the returned feed.
--   2. Pure nearest-neighbour returns a monotone feed when a user has a
--      lopsided taste (e.g. 22/24 anime). Hurts discovery and reads as
--      "same same" to the user.
--
-- Fix: pre-fetch a wider pool (top 200 by similarity), dedupe by file_path,
-- then cap each category at greatest(8, p_count/2). For p_count=24 the cap is
-- 12 — anime can still dominate, but at least half the row is variety. If
-- the user has a narrow embedding (everything close to anime) the fallback
-- order-by-distance still fills empty slots from the same category, so we
-- never under-fill below the available candidates.
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
language plpgsql stable
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
    -- Pull 8x the requested count so we have headroom for dedup + diversity
    select
      w.id,
      w.file_path,
      w.category,
      (1 - (w.embedding <=> v_taste))::real as similarity,
      w.embedding <=> v_taste as distance
    from public.wallpapers w
    where w.embedding is not null
    order by w.embedding <=> v_taste
    limit greatest(200, p_count * 8)
  ),
  deduped as (
    -- One row per file_path; keeps the closest variant when wallpapers table
    -- has duplicate rows for the same image.
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
        order by d.distance
      ) as rank_in_cat
    from deduped d
  )
  select r.id, r.file_path, r.category, r.similarity
  from ranked r
  where r.rank_in_cat <= v_cat_cap
  order by r.distance
  limit greatest(1, least(p_count, 100));
end;
$$;

grant execute on function public.recommend_for_user(uuid, integer) to authenticated;
