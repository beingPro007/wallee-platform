-- Add subscription_source column to profiles table with default 'mobile'
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS subscription_source text DEFAULT 'mobile';

-- Ensure the default is set to 'mobile' (in case the column already existed with a different default from a previous run)
ALTER TABLE public.profiles 
ALTER COLUMN subscription_source SET DEFAULT 'mobile';
