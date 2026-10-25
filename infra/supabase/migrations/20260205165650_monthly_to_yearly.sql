-- Migrate all existing 'monthly' subscriptions to 'yearly' column
-- This ensures consistency as we are renaming the plan to Yearly
UPDATE public.subscriptions
SET plan_type = 'yearly'
WHERE plan_type = 'monthly';
