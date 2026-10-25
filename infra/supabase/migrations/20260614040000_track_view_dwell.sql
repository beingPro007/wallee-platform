-- ============================================================================
-- track_view — record dwell time on a wallpaper detail screen as a taste
-- signal. Maps to existing _update_user_taste with a piecewise weight curve:
--   <  3 s  → skipped (probably accidental open)
--   3-10 s  → 0.3   (glanced)
--   10-30 s → 0.6   (looked)
--   ≥ 30 s  → 1.0   (engaged)
--
-- This complements explicit signals (favourite, download, collect) with an
-- implicit one — what the user keeps looking at, even without acting on it.
-- ============================================================================

create or replace function public.track_view(
  p_user_id       uuid,
  p_wallpaper_url text,
  p_dwell_ms      integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_weight double precision;
begin
  if p_user_id is null then return; end if;
  if p_dwell_ms is null or p_dwell_ms < 3000 then return; end if;

  v_weight := case
    when p_dwell_ms < 10000 then 0.3
    when p_dwell_ms < 30000 then 0.6
    else 1.0
  end;

  perform public._update_user_taste(p_user_id, p_wallpaper_url, v_weight);
end;
$$;

grant execute on function public.track_view(uuid, text, integer) to authenticated;
