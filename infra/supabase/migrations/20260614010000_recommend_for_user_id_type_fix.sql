-- ============================================================================
-- recommend_for_user.id should be bigint, not integer.
-- wallpapers.id is bigint; the function's return column was declared `integer`
-- so PostgREST refused the call with:
--   structure of query does not match function result type
--   Returned type bigint does not match expected type integer in column 1.
-- Postgres disallows changing return types via CREATE OR REPLACE, so we DROP
-- the prior signature first.
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
begin
  if p_user_id is null then return; end if;

  select t.vector into v_taste
  from public.user_taste t
  where t.user_id = p_user_id
  limit 1;
  if v_taste is null then return; end if;

  return query
  select
    w.id,
    w.file_path,
    w.category,
    (1 - (w.embedding <=> v_taste))::real as similarity
  from public.wallpapers w
  where w.embedding is not null
  order by w.embedding <=> v_taste
  limit greatest(1, least(p_count, 100));
end;
$$;

grant execute on function public.recommend_for_user(uuid, integer) to authenticated;
