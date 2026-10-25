-- Ensure profiles table structure matches requirements
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS subscription_status text CHECK (subscription_status IN ('active', 'cancelled', 'expired', 'past_due')),
ADD COLUMN IF NOT EXISTS subscription_id text,
ADD COLUMN IF NOT EXISTS subscription_source text DEFAULT 'mobile';

-- Create the new subscriptions table for detailed tracking
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  subscription_id TEXT, 
  payment_id TEXT, 
  status TEXT NOT NULL,
  plan_type TEXT CHECK (plan_type IN ('monthly', 'yearly', 'one_time')),
  amount NUMERIC,
  currency TEXT DEFAULT 'USD',
  period_start TIMESTAMP WITH TIME ZONE DEFAULT now(),
  period_end TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own subscriptions" 
ON public.subscriptions FOR SELECT 
USING (auth.uid() = user_id);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_sub_id ON public.subscriptions(subscription_id);
