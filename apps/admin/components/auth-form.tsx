"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase/client";
export function AuthForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await getSupabaseClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (result.error) throw result.error;
      router.replace("/protected");
      router.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="ops-signin">
      <div className="signin-icon">
        <LockKeyhole size={20} />
      </div>
      <h2>Welcome to your workspace</h2>
      <p>
        Sign in to see what’s happening across Wallee.
        <br />
        Access is restricted to approved administrators.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          autoComplete="username"
          disabled={loading}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password"
          required
          autoComplete="current-password"
          disabled={loading}
        />
        {error && (
          <div className="source-error" style={{ marginTop: 15 }} role="alert">
            {error}
          </div>
        )}
        <button className="ops-button primary" type="submit" disabled={loading}>
          {loading ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <>
              Sign in to Wallee
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>
      <div className="signin-private">
        <ShieldCheck size={13} />
        Private access · home curation & operations
      </div>
    </section>
  );
}
