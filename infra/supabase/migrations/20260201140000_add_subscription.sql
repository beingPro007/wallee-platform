-- Add subscription columns to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS subscription_status text CHECK (subscription_status IN ('active', 'cancelled', 'expired', 'past_due')),
ADD COLUMN IF NOT EXISTS subscription_id text;

-- Policy to allow users to read their own subscription status
CREATE POLICY "Users can read own subscription status" 
ON public.profiles FOR SELECT 
USING (auth.uid() = user_id);
