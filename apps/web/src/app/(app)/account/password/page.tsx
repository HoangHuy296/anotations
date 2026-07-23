import Link from "next/link";
import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { AppShell } from "@/components/layout/app-shell";
import { getRequestActor } from "@/lib/auth";

export default async function AccountPasswordPage() {
  if (!(await getRequestActor())) redirect("/unauthorized");
  return <AppShell currentPath="/account">
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-700">Account</p>
      <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-zinc-950">Change password</h1>
      <p className="mt-3 text-sm leading-6 text-zinc-500">For your security, changing your password signs out any other active devices.</p>
      <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6"><ChangePasswordForm /></section>
      <p className="mt-5 text-sm text-zinc-500"><Link className="font-semibold text-sky-700 hover:text-sky-800" href="/account">Back to personal information</Link></p>
    </div>
  </AppShell>;
}
