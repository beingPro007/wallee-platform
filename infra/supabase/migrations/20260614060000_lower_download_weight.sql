-- ============================================================================
-- Rebalance signal weights so favourites carry meaningfully more pull:
--   favourites:        1.5  → 3.0  (2x bump — strongest explicit signal)
--   downloads:         1.0  → 0.5  (halved — large-volume noisy signal)
--   collection-adds:   1.2 unchanged (still a deliberate-but-soft signal)
--
-- For a typical user (2x more downloads than favs), this flips the
-- contribution ratio from "downloads 58% / favs 42%" to "favs 74% /
-- downloads 26%". The For You row should now read as a much closer match
-- to what the user actively liked, not just what they saved offline.
--
-- Two parts:
--   1. Update both triggers so all future events use the new weights.
--   2. Rebuild every user's existing user_taste vector from scratch with
--      the new weights — historic interactions get re-weighted; otherwise
--      the change would barely register for heavy users.
--
-- Trade-off: any dwell-time signals accumulated since track_view was
-- deployed are lost (they weren't recorded as separate rows, only summed
-- into the vector). Will re-accumulate organically as the user keeps
-- using the app.
-- ============================================================================

-- 1. New trigger weights
create or replace function public._on_favourites_insert()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  perform public._update_user_taste(new.user_id, new.wallpaper_url, 3.0);
  return null;
end;
$$;

create or replace function public._on_user_downloads_insert()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  perform public._update_user_taste(new.user_id, new.wallpaper_url, 0.5);
  return null;
end;
$$;

-- 2. Wipe + rebuild all user_taste rows with the new weights
truncate table public.user_taste;

do $$
declare
  r record;
begin
  for r in select user_id, wallpaper_url from public.favourites
  loop
    perform public._update_user_taste(r.user_id, r.wallpaper_url, 3.0);
  end loop;

  for r in select user_id, wallpaper_url from public.user_downloads
  loop
    perform public._update_user_taste(r.user_id, r.wallpaper_url, 0.5);
  end loop;

  for r in
    select c.user_id, cw.wallpaper_url
    from public.collection_wallpapers cw
    join public.collections c on c.id = cw.collection_id
  loop
    perform public._update_user_taste(r.user_id, r.wallpaper_url, 1.2);
  end loop;

  raise notice 'rebuild complete: % taste rows',
    (select count(*) from public.user_taste);
end;
$$;
