-- Update plan_type check constraint to include 'lifetime' and 'monthly'
ALTER TABLE public.subscriptions
DROP CONSTRAINT IF EXISTS subscriptions_plan_type_check;

ALTER TABLE public.subscriptions
ADD CONSTRAINT subscriptions_plan_type_check 
CHECK (plan_type IN ('monthly', 'lifetime', 'yearly', 'one_time'));
-- Keeping yearly/one_time for safety, but we will primarily use monthly and lifetime.
