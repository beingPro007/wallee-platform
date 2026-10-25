create table if not exists public.home_sections (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,
  json_url        text not null default '',
  s3_prefix       text not null default '',
  is_fresh_drops  boolean not null default false,
  position        integer not null default 999,
  is_enabled      boolean not null default true,
  cover_image_url text,
  wallpaper_count integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Only one section can be the fresh-drops banner
create unique index if not exists home_sections_fresh_drops_idx
  on public.home_sections (is_fresh_drops)
  where is_fresh_drops = true;

alter table public.home_sections enable row level security;

create policy "Public can read enabled sections"
  on public.home_sections for select
  using (is_enabled = true);

create policy "Authenticated can manage sections"
  on public.home_sections for all
  using (auth.uid() is not null);

-- Auto-update updated_at on every row update
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger home_sections_updated_at
  before update on public.home_sections
  for each row execute function public.set_updated_at();
