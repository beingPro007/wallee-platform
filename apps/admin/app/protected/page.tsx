import { redirect } from "next/navigation";
import { requireOpsUser, AccessError } from "@/lib/ops/auth";
import { OperationsDashboard } from "@/components/ops/dashboard";
import { SignOutButton } from "@/components/ops/sign-out";
export default async function Protected({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  let email: string;
  try {
    email = (await requireOpsUser()).email!;
  } catch (error) {
    if (error instanceof AccessError && error.status === 401)
      redirect("/auth/sign-in");
    return (
      <main className="auth-denied">
        <div>
          <h1>Private workspace</h1>
          <p>
            This dashboard is available only to the approved administrator
            accounts. Billing and storage data have not been loaded.
          </p>
          <SignOutButton />
        </div>
      </main>
    );
  }
  return (
    <OperationsDashboard
      email={email}
      initialView={(await searchParams).view === "home" ? "home" : "overview"}
    />
  );
}
