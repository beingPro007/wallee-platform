-- Remove subscription fields from profiles table
ALTER TABLE public.profiles
DROP COLUMN IF EXISTS subscription_status,
DROP COLUMN IF EXISTS subscription_id,
DROP COLUMN IF EXISTS subscription_source;
