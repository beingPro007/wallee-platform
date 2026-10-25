-- ============================================================================
-- User taste vectors + recommendation RPC.
--
-- Stores one 768-d vector per user — a running mean of CLIP embeddings for
-- wallpapers they've interacted with. Updated incrementally via triggers on
-- favourites, user_downloads and collection_wallpapers inserts. Queries are
-- nearest-neighbour by cosine distance against wallpapers.embedding (already
-- pgvector(768) — see classifier.py / sync_wallpapers.py).
--
-- All triggers run SECURITY DEFINER so they can write to user_taste regardless
-- of the source table's RLS — and they swallow lookup failures (embedding
-- missing, malformed URL) so a single bad row never blocks an interaction.
-- Idempotent — safe to re-run.
-- ============================================================================

-- ── 1. Storage ──────────────────────────────────────────────────────────────

-- interaction_count is `double precision` (not int) because per-source weights
-- are fractional (favourites = 1.5, collection adds = 1.2, downloads = 1.0).
-- It's `double precision` rather than `real` because pgvector only defines
-- scalar multiply as `vector * float8`, and using the same type everywhere
-- avoids implicit-cast noise.
-- Treat the field semantically as "total weighted interactions accumulated."
create table if not exists public.user_taste (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  vector            vector(768),
  interaction_count double precision not null default 0,
  updated_at        timestamptz not null default now()
);

alter table public.user_taste enable row level security;
alter table public.user_taste force row level security;

drop policy if exists "user_taste_select_own" on public.user_taste;
create policy "user_taste_select_own" on public.user_taste
  for select to authenticated
  using (auth.uid() = user_id);

-- No INSERT/UPDATE policies — only the SECURITY DEFINER triggers below mutate
-- this table. service_role retains full access via bypass.

-- ── 2. Helpers ──────────────────────────────────────────────────────────────

-- CloudFront URL → relative file_path (matches wallpapers.file_path).
create or replace function public._taste_url_to_path(p_url text)
returns text language sql immutable as $$
  select case
    when p_url is null then null
    when p_url like 'http%' then regexp_replace(p_url, '^https?://[^/]+/', '')
    else ltrim(p_url, '/')
  end;
$$;

-- pgvector doesn't ship a scalar-multiply operator (`vector * scalar`). Only
-- vector-by-vector element-wise arithmetic is supported. We need scaling for
-- per-source weighting (favourites=1.5, etc.), so we round-trip through
-- float4[] (the underlying storage type of `vector`).
create or replace function public._vec_scale(v vector, k double precision)
returns vector language sql immutable as $$
  select (array(select unnest(v::float4[]) * k))::vector;
$$;

-- Update the running SUM. user_taste.vector stores the weighted sum of all
-- interacted embeddings (NOT the mean):
--   new_vec   = old_vec + e * w
--   new_count = old_count + w
-- pgvector's <=> (cosine distance) is scale-invariant — i.e. cos(a, k·b) ==
-- cos(a, b) for any k > 0 — so storing the sum gives identical neighbour
-- ordering to storing the mean, with simpler math and no per-update division.
-- interaction_count is kept around for cold-start detection ("user has < N
-- interactions, show trending") and for inspection in queries.
create or replace function public._update_user_taste(
  p_user_id uuid,
  p_wallpaper_url text,
  p_weight double precision default 1.0
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_emb  vector(768);
  v_path text;
begin
  if p_user_id is null or p_weight <= 0 then
    return;
  end if;

  v_path := _taste_url_to_path(p_wallpaper_url);
  if v_path is null or v_path = '' then
    return;
  end if;

  select w.embedding into v_emb
  from public.wallpapers w
  where w.file_path = v_path
    and w.embedding is not null
  limit 1;
  if v_emb is null then
    return; -- no embedding for this wallpaper — silent skip
  end if;

  insert into public.user_taste (user_id, vector, interaction_count, updated_at)
  values (p_user_id, public._vec_scale(v_emb, p_weight), p_weight, now())
  on conflict (user_id) do update set
    vector            = public.user_taste.vector + excluded.vector,
    interaction_count = public.user_taste.interaction_count + p_weight,
    updated_at        = now();
end;
$$;

-- ── 3. Triggers (one per interaction table) ─────────────────────────────────

-- Favourites — strongest positive signal.
create or replace function public._on_favourites_insert()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  perform public._update_user_taste(new.user_id, new.wallpaper_url, 1.5);
  return null;
end;
$$;

drop trigger if exists trg_favourites_taste on public.favourites;
create trigger trg_favourites_taste
  after insert on public.favourites
  for each row execute function public._on_favourites_insert();

-- Downloads — strong but generic interest signal.
create or replace function public._on_user_downloads_insert()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  perform public._update_user_taste(new.user_id, new.wallpaper_url, 1.0);
  return null;
end;
$$;

drop trigger if exists trg_downloads_taste on public.user_downloads;
create trigger trg_downloads_taste
  after insert on public.user_downloads
  for each row execute function public._on_user_downloads_insert();

-- Collection adds — owner of the collection gets the signal.
create or replace function public._on_collection_wallpapers_insert()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  select c.user_id into v_user
  from public.collections c
  where c.id = new.collection_id
  limit 1;
  if v_user is null then return null; end if;
  perform public._update_user_taste(v_user, new.wallpaper_url, 1.2);
  return null;
end;
$$;

drop trigger if exists trg_collection_wallpapers_taste on public.collection_wallpapers;
create trigger trg_collection_wallpapers_taste
  after insert on public.collection_wallpapers
  for each row execute function public._on_collection_wallpapers_insert();

-- ── 4. Recommendation RPC ───────────────────────────────────────────────────
-- Cosine-nearest wallpapers to the user's taste vector. Returns empty when
-- the user has no taste row yet (cold start) — the client should fall back to
-- trending / popular in that case.

create or replace function public.recommend_for_user(
  p_user_id uuid,
  p_count integer default 30
) returns table (
  id integer,
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

-- ── 5. Backfill — bootstrap taste vectors from existing interactions ────────
-- One-shot at deploy time so users with prior favourites/collections get
-- immediate recommendations instead of waiting for new activity. Safe to run
-- multiple times — uses the same upsert path as the triggers, so the math
-- just accumulates. We only run it when user_taste is empty so re-deploys
-- don't double-count.

do $$
declare
  v_existing int;
  r record;
begin
  select count(*) into v_existing from public.user_taste;
  if v_existing > 0 then
    raise notice 'user_taste already has % rows — skipping backfill', v_existing;
    return;
  end if;

  for r in
    select user_id, wallpaper_url from public.favourites
  loop
    perform public._update_user_taste(r.user_id, r.wallpaper_url, 1.5);
  end loop;

  for r in
    select user_id, wallpaper_url from public.user_downloads
  loop
    perform public._update_user_taste(r.user_id, r.wallpaper_url, 1.0);
  end loop;

  for r in
    select c.user_id, cw.wallpaper_url
    from public.collection_wallpapers cw
    join public.collections c on c.id = cw.collection_id
  loop
    perform public._update_user_taste(r.user_id, r.wallpaper_url, 1.2);
  end loop;

  raise notice 'backfill complete: % taste rows', (select count(*) from public.user_taste);
end;
$$;
