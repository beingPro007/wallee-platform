-- ============================================================================
-- Security hardening: enable RLS + tight policies on tables that were either
-- unprotected or had overly-permissive policies. Idempotent; safe to re-run.
--
-- Threat model: a malicious actor extracts SUPABASE_ANON_KEY from the APK
-- and hits PostgREST directly. Without these policies:
--   • wallpapers          → full catalog enumeration (CloudFront scraping)
--   • user_downloads      → quota bypass (rewarded-ad flow becomes pointless)
--   • upscale_queue       → operational data leaked
--   • trending_wallpapers → analytics writeable by anyone
--   • home_sections       → ANY logged-in user could disable/edit sections
--                           (the existing "Authenticated can manage" policy)
--
-- Anything not covered here already has its policies in earlier migrations:
--   • collections, collection_wallpapers   → 20260228062909_collection_rls_fix
--   • collection_likes                     → 20260228063739_collection_likes_rls_fix
--   • profiles                             → 20260221053903_profiles_fixes
-- ============================================================================

-- helper: idempotently apply a block only if the table exists.
-- Takes the table name as TEXT (not regclass) so the missing-table case is
-- a NULL check inside the function, not a parse-time cast failure.
create or replace function public._rls_if_table_exists(
  tbl_name text,
  stmt text
) returns void language plpgsql as $$
begin
  if to_regclass(tbl_name) is null then
    return;
  end if;
  execute stmt;
exception
  when undefined_table then null;
  when undefined_object then null;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) wallpapers — public-readable catalog, no client writes
-- ────────────────────────────────────────────────────────────────────────────
alter table public.wallpapers enable row level security;
alter table public.wallpapers force row level security;

drop policy if exists "wallpapers_select_public" on public.wallpapers;
create policy "wallpapers_select_public" on public.wallpapers
  for select
  to anon, authenticated
  using (true);

-- no INSERT/UPDATE/DELETE policies → only service_role can mutate
-- (the upscaler/classifier Modal jobs use SUPABASE_SERVICE_KEY)

-- ────────────────────────────────────────────────────────────────────────────
-- 2) user_downloads — per-user quota tracking
--    Without RLS, a user can hit PostgREST with another user's user_id to
--    bypass the daily-download quota that gates the rewarded-ad flow.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.user_downloads enable row level security;
alter table public.user_downloads force row level security;

drop policy if exists "user_downloads_select_own" on public.user_downloads;
create policy "user_downloads_select_own" on public.user_downloads
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_downloads_insert_own" on public.user_downloads;
create policy "user_downloads_insert_own" on public.user_downloads
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- no UPDATE/DELETE → quota records are append-only from the client

-- ────────────────────────────────────────────────────────────────────────────
-- 3) upscale_queue — service_role only
--    No client should ever see queue state. Modal worker authenticates with
--    the service key and bypasses RLS.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.upscale_queue enable row level security;
alter table public.upscale_queue force row level security;

-- intentionally NO policies → anon/authenticated get nothing,
-- service_role bypasses RLS and retains full access.
drop policy if exists "upscale_queue_select_all"        on public.upscale_queue;
drop policy if exists "upscale_queue_select_authenticated" on public.upscale_queue;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) trending_wallpapers — authenticated SELECT only
--    (table may not exist on every env — view trending_wallpapers_view sits
--     on top of it. Guard with the helper.)
-- ────────────────────────────────────────────────────────────────────────────
select public._rls_if_table_exists(
  'public.trending_wallpapers',
  $sql$
    alter table public.trending_wallpapers enable row level security;
    alter table public.trending_wallpapers force row level security;
    drop policy if exists "trending_wallpapers_select" on public.trending_wallpapers;
    create policy "trending_wallpapers_select" on public.trending_wallpapers
      for select to authenticated using (true);
  $sql$
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) home_sections — fix the overly-broad "any authenticated user can manage"
--    policy. The admin tool (insta-s3-client-uploader) uses service_role and
--    bypasses RLS, so dropping the broad ALL policy is safe.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.home_sections enable row level security;
alter table public.home_sections force row level security;

-- remove the dangerous catch-all
drop policy if exists "Authenticated can manage sections" on public.home_sections;

-- keep public read of enabled sections (used by the hero deck)
drop policy if exists "Public can read enabled sections" on public.home_sections;
create policy "home_sections_select_enabled" on public.home_sections
  for select
  to anon, authenticated
  using (is_enabled = true);

-- (no other policies → INSERT/UPDATE/DELETE only via service_role)

-- ────────────────────────────────────────────────────────────────────────────
-- 6) favourites (legacy table, triggered by collection_wallpapers sync)
--    Add per-user RLS if the table exists. Triggers run as SECURITY DEFINER
--    so they bypass RLS — the policy only affects direct client calls.
-- ────────────────────────────────────────────────────────────────────────────
select public._rls_if_table_exists(
  'public.favourites',
  $sql$
    alter table public.favourites enable row level security;
    alter table public.favourites force row level security;

    drop policy if exists "favourites_select_own" on public.favourites;
    create policy "favourites_select_own" on public.favourites
      for select to authenticated using (auth.uid() = user_id);

    drop policy if exists "favourites_insert_own" on public.favourites;
    create policy "favourites_insert_own" on public.favourites
      for insert to authenticated with check (auth.uid() = user_id);

    drop policy if exists "favourites_delete_own" on public.favourites;
    create policy "favourites_delete_own" on public.favourites
      for delete to authenticated using (auth.uid() = user_id);
  $sql$
);

-- ────────────────────────────────────────────────────────────────────────────
-- 7) Sanity grants — keep PostgREST happy. RLS gates rows; column-level
--    grants gate operations. These should already match the defaults but we
--    re-assert to avoid 401s after a permission reset.
-- ────────────────────────────────────────────────────────────────────────────
grant select on public.wallpapers       to anon, authenticated;
grant select on public.home_sections    to anon, authenticated;
grant select, insert on public.user_downloads to authenticated;

-- cleanup helper
drop function if exists public._rls_if_table_exists(text, text);
