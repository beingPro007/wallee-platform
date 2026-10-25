import { createClient } from "@/lib/supabase/server";

export class AccessError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function isAllowedEmail(
  email: string | undefined,
  verified: boolean,
  configured = process.env.OPS_ADMIN_EMAILS ?? "",
) {
  const allowed = configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return verified && !!email && allowed.includes(email.toLowerCase());
}
export async function requireOpsUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new AccessError(401, "Sign in to view operations.");
  if (!isAllowedEmail(user.email, !!user.email_confirmed_at))
    throw new AccessError(
      403,
      "This account is not on the operations access list.",
    );
  return user;
}
