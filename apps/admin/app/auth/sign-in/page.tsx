import { Layers3, Radio } from "lucide-react";
import { AuthForm } from "@/components/auth-form";
export default function SignIn() {
  return (
    <main className="ops-auth">
      <section className="auth-brand-side">
        <div className="ops-brand">
          <span className="ops-mark">
            <Layers3 size={23} />
          </span>
          <span>
            Wallee<span className="brand-sub">OPERATIONS</span>
          </span>
        </div>
        <div className="auth-copy">
          <div className="eyebrow">CLARITY AT EVERY STAGE</div>
          <h1>
            Your pipeline.
            <br />
            Your infrastructure.
            <br />
            <span>One clear picture.</span>
          </h1>
          <p>
            From the first download to the final wallpaper. Follow your
            processing, understand your storage, and keep an eye on AWS costs.
          </p>
          <div className="auth-feature">
            <Radio size={20} />
            <span>Real operations. Real data. No guesswork.</span>
          </div>
        </div>
        <div className="auth-brand-footer">
          Wallee workspace · Home curation & operations
        </div>
      </section>
      <section className="auth-form-side">
        <AuthForm />
      </section>
    </main>
  );
}
