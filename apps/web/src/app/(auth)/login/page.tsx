import { redirect } from "next/navigation";

import { CredentialsForm } from "@/components/auth/credentials-form";
import { getRequestActor } from "@/lib/auth";
import { safeReturnTarget } from "@/lib/auth-redirect";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const targetValue = (await searchParams).returnTo;
  const returnTo = safeReturnTarget(Array.isArray(targetValue) ? targetValue[0] : targetValue);
  if (await getRequestActor()) redirect(returnTo);
  return <CredentialsForm mode="login" returnTo={returnTo} />;
}
