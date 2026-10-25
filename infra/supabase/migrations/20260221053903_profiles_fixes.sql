-- First, backfill profiles for any users that are missing them
-- This ensures the foreign key constraint doesn't fail
INSERT INTO public.profiles (user_id)
SELECT DISTINCT user_id FROM public.collections
ON CONFLICT (user_id) DO NOTHING;

-- Also backfill from auth.users to be safe
INSERT INTO public.profiles (user_id)
SELECT id FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- Now add the constraint
-- We use a DO block to make it idempotent
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'collections_user_id_profiles_fkey'
    ) THEN
        ALTER TABLE public.collections
        ADD CONSTRAINT collections_user_id_profiles_fkey
        FOREIGN KEY (user_id) REFERENCES public.profiles(user_id);
    END IF;
END $$;

-- Ensure RLS allows reading profiles for the community tab
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles
FOR SELECT USING (true);