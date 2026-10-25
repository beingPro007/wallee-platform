-- Add source column to profiles with default 'mobile'
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS source text DEFAULT 'mobile';

-- Backfill existing profiles
UPDATE public.profiles SET source = 'mobile' WHERE source IS NULL;
