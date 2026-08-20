"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, KeyboardEvent, useState } from "react";

import { Briefcase, Eye, PencilSimple } from "@phosphor-icons/react";

import { safeReturnTarget } from "@/lib/auth-redirect";

type CredentialsFormProps = { mode: "login" | "register"; returnTo: string };
type RegistrationRole = "MANAGER" | "LABELER" | "REVIEWER";

const registrationRoles: Array<{ value: RegistrationRole; title: string; description: string; icon: typeof Briefcase }> = [
  { value: "MANAGER", title: "Manager", description: "Create and manage datasets, labels, imports, and team work.", icon: Briefcase },
  { value: "LABELER", title: "Labeler", description: "Create and refine annotations on assets assigned to you.", icon: PencilSimple },
  { value: "REVIEWER", title: "Reviewer", description: "Review and approve annotation work within assigned datasets.", icon: Eye },
];

export function CredentialsForm({ mode, returnTo }: CredentialsFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [selectedRole, setSelectedRole] = useState<RegistrationRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const destination = safeReturnTarget(returnTo);
  const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(mode === "register" ? { email, password, name: name.trim() || undefined, role: selectedRole } : { email, password }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(payload?.error?.message ?? "We could not complete that request. Check your details and try again.");
        return;
      }
      setPassword("");
      if (mode === "register") {
        // Registration only creates the account; it does not sign the user
        // in. Send them to the login page to authenticate explicitly.
        router.replace(`/login?returnTo=${encodeURIComponent(destination)}`);
      } else {
        router.replace(destination);
        router.refresh();
      }
    } catch {
      setError("The sign-in service is unavailable. Try again shortly.");
    } finally {
      setPending(false);
    }
  }

  const title = mode === "login" ? "Sign in to Annotation Platform" : "Create your Annotation Platform account";
  const alternateHref = mode === "login" ? `/register?returnTo=${encodeURIComponent(destination)}` : `/login?returnTo=${encodeURIComponent(destination)}`;

  function selectRole(role: RegistrationRole) {
    setSelectedRole(role);
    setError(null);
  }

  function handleRoleKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? registrationRoles.length - 1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? (currentIndex + 1) % registrationRoles.length : (currentIndex - 1 + registrationRoles.length) % registrationRoles.length;
    const nextRole = registrationRoles[nextIndex];
    if (!nextRole) return;
    selectRole(nextRole.value);
    document.getElementById(`registration-role-${nextRole.value}`)?.focus();
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-zinc-50 px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-[0_24px_70px_-45px_rgba(24,24,27,0.45)] sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-700">Annotation Platform</p>
        <h1 className="mt-3 text-2xl font-bold tracking-[-0.03em] text-zinc-950">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500">Your session is kept in a secure HTTP-only cookie.</p>
        <form className="mt-7 space-y-5" onSubmit={submit}>
          {mode === "register" ? <fieldset>
            <legend className="text-sm font-semibold text-zinc-800">Choose your role</legend>
            <p className="mt-1 text-xs leading-5 text-zinc-500">Your permissions are still limited to datasets you own or are assigned to.</p>
            <div className="mt-3 grid gap-2" role="radiogroup" aria-label="Registration role">
              {registrationRoles.map(({ value, title, description, icon: Icon }, index) => {
                const selected = selectedRole === value;
                return <button key={value} id={`registration-role-${value}`} type="button" role="radio" aria-checked={selected} onClick={() => selectRole(value)} onKeyDown={(event) => handleRoleKeyDown(event, index)} className={`group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-[border-color,background-color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 active:translate-y-px ${selected ? "border-sky-600 bg-sky-50" : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50"}`}>
                  <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${selected ? "bg-sky-600 text-white" : "bg-zinc-100 text-zinc-600"}`}><Icon size={17} weight="bold" /></span>
                  <span><span className="block text-sm font-semibold text-zinc-900">{title}</span><span className="mt-0.5 block text-xs leading-5 text-zinc-500">{description}</span></span>
                </button>;
              })}
            </div>
          </fieldset> : null}
          {mode === "register" && <label className="block text-sm font-semibold text-zinc-800">
            Name <span className="font-normal text-zinc-500">(optional)</span>
            <input className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-zinc-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} />
          </label>}
          <label className="block text-sm font-semibold text-zinc-800">
            Email
            <input className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-zinc-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={320} />
          </label>
          <label className="block text-sm font-semibold text-zinc-800">
            Password
            <input className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-zinc-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={256} />
            <span className="mt-1 block text-xs font-normal text-zinc-500">Use at least 12 characters.</span>
          </label>
          {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
          <button type="submit" className="h-11 w-full rounded-xl bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50" disabled={pending || (mode === "register" && !selectedRole)}>{pending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
        </form>
        <p className="mt-6 text-center text-sm text-zinc-500">{mode === "login" ? "New to Annotation Platform?" : "Already have an account?"} <Link className="font-semibold text-sky-700 hover:text-sky-800" href={alternateHref}>{mode === "login" ? "Register" : "Sign in"}</Link></p>
      </section>
    </main>
  );
}
