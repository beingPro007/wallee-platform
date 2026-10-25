-- Enforce UNIQUE(file_path) on public.wallpapers.
--
-- Why: the image-processing upscaler registers each finished wallpaper with an
-- upsert ON CONFLICT (file_path). Without a matching unique constraint that
-- errors with 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
-- specification"), so upscaled wallpapers (mobile + desktop) were never embedded
-- into this table. This also lets the recommend/search paths stop working around
-- duplicate file_path rows (see 20260614020000_recommend_dedup_diversify.sql).

-- 1. De-duplicate existing rows: keep one row per file_path.
--    (ctid comparison is type-agnostic and always available.)
DELETE FROM public.wallpapers a
USING public.wallpapers b
WHERE a.file_path = b.file_path
  AND a.ctid < b.ctid;

-- 2. Add the unique constraint (idempotent — safe to re-run).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallpapers_file_path_key'
  ) THEN
    ALTER TABLE public.wallpapers
      ADD CONSTRAINT wallpapers_file_path_key UNIQUE (file_path);
  END IF;
END $$;
