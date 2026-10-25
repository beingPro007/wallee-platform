"use client";
import { getSupabaseClient } from "@/lib/supabase/client";
export function SignOutButton() {
  return (
    <button
      className="ops-button"
      onClick={async () => {
        await getSupabaseClient().auth.signOut();
        window.location.assign("/auth/sign-in");
      }}
    >
      Sign in with another account
    </button>
  );
}
