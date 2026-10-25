-- Migration at supabase/migrations/20260207_add_source_to_profiles.sql
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS source text DEFAULT 'mobile';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, source)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'source', 'mobile')
  )
  ON CONFLICT (user_id) DO UPDATE
  SET source = EXCLUDED.source
  WHERE profiles.source IS NULL OR profiles.source = 'mobile';
  
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

UPDATE public.profiles SET source = 'mobile' WHERE source IS NULL;
