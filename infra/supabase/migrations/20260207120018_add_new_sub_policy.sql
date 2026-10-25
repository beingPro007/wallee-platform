-- 1. Remove duplicate subscription records for each user
-- Keep only the most recent record based on created_at
DELETE FROM public.subscriptions a
USING public.subscriptions b
WHERE a.user_id = b.user_id
  AND a.created_at < b.created_at;

-- 2. Add unique constraint to user_id to ensure one row per user
-- We first drop any existing unique constraints on subscription_id if they exist from previous attempts
ALTER TABLE public.subscriptions 
DROP CONSTRAINT IF EXISTS unique_subscription_id;

ALTER TABLE public.subscriptions 
ADD CONSTRAINT unique_user_subscription UNIQUE (user_id);

-- 3. (Optional) We can still keep subscription_id unique if we want, but it's not strictly necessary for the "one row per user" model if user_id is unique. 
-- However, it helps prevent the same external subscription ID from being assigned to multiple users (which shouldn't happen anyway).
-- ALTER TABLE public.subscriptions ADD CONSTRAINT unique_subscription_id UNIQUE (subscription_id);
