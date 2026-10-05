import {
  BellSimple,
  Export,
  Eye,
  Lifebuoy,
  Translate,
  UserCircle,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccessibilityForm } from "@/components/account/accessibility-form";
import { ExportsHistoryPanel } from "@/components/account/exports-history-panel";
import { LanguageSelect } from "@/components/account/language-select";
import { NotificationsToggle } from "@/components/account/notifications-toggle";
import { AccountProfileForm } from "@/components/auth/account-profile-form";
import { AccountSectionNav } from "@/components/account/account-section-nav";
import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { getRequestActor } from "@/lib/auth";
import { isDatabaseConfigured } from "@/lib/db";
import { listSafeExportJobsForActor } from "@/lib/exports/export-service";
import { readAccountPreferences } from "@/lib/validation/account-preferences";

const roleLabels: Record<string, string> = {
  ADMIN: "Administrator", MANAGER: "Manager", LABELER: "Labeler", REVIEWER: "Reviewer",
};

export default async function AccountPage() {
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const preferences = readAccountPreferences(actor.preferences);
  const exports = isDatabaseConfigured()
    ? await listSafeExportJobsForActor(actor, { limit: 10 })
    : { items: [], nextCursor: null };

  return (
    <AppShell currentPath="/account">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <header className="border-b border-zinc-200 pb-7 dark:border-zinc-800">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-400">Account</p>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-zinc-950 dark:text-zinc-50">Settings</h1>
          <p className="mt-2 max-w-[65ch] text-sm leading-6 text-zinc-500 dark:text-zinc-400">Manage your profile, notifications, exports, language, and accessibility preferences.</p>
        </header>

        <div className="mt-8 grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start">
          <AccountSectionNav />

          <div className="min-w-0 space-y-8">
            <section id="account" className="scroll-mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <SectionHeading icon={UserCircle} title="Account & subscription" description="Update the name your teammates see in Annotation Platform." />
              <AccountProfileForm initialName={actor.name} email={actor.email} />
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-800/60">
                <div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Workspace role</p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Roles are managed by an administrator.</p>
                </div>
                <Badge variant="info">{roleLabels[actor.role] ?? actor.role}</Badge>
              </div>
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm leading-6 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-400">
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">Subscription: </span>
                Annotation Platform is deployed for your organization without a separate billing step in this app. If your organization uses paid seats or tiers, that is managed by your administrator outside Annotation Platform.
              </div>
              <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400">Need to update your sign-in credentials? <Link className="font-semibold text-sky-700 hover:text-sky-800 dark:text-sky-400 dark:hover:text-sky-300" href="/account/password">Change your password</Link>.</p>
            </section>

            <section id="notifications" className="scroll-mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <SectionHeading icon={BellSimple} title="Notifications" description="Control whether Annotation Platform creates in-app notifications for you." />
              <NotificationsToggle initialEnabled={preferences.notificationsEnabled} />
            </section>

            <section id="exports" className="scroll-mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <SectionHeading icon={Export} title="Exports & downloads" description="Your own generated exports, ready to download again at any time." />
                <Link className="shrink-0 text-sm font-semibold text-sky-700 hover:text-sky-800 dark:text-sky-400 dark:hover:text-sky-300" href="/exports">Create new export</Link>
              </div>
              <div className="mt-2">
                <ExportsHistoryPanel initialItems={exports.items} initialNextCursor={exports.nextCursor} />
              </div>
            </section>

            <section id="language" className="scroll-mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <SectionHeading icon={Translate} title="Language" description="Choose the language Annotation Platform's interface is displayed in." />
              <LanguageSelect initialLanguage={preferences.language} />
            </section>

            <section id="accessibility" className="scroll-mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <SectionHeading icon={Eye} title="Accessibility" description="These apply across Annotation Platform as soon as you turn them on." />
              <AccessibilityForm initial={preferences.accessibility} />
            </section>

            <section id="support" className="scroll-mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <SectionHeading icon={Lifebuoy} title="Support" description="Need help with Annotation Platform?" />
              <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                Contact your workspace administrator or the team that manages your Annotation Platform deployment. They can help with access, dataset permissions, and anything else account-related.
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function SectionHeading({ icon: Icon, title, description }: { icon: typeof UserCircle; title: string; description: string }) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-400"><Icon aria-hidden="true" size={18} weight="duotone" /></span>
      <div>
        <h2 className="text-lg font-bold text-zinc-950 dark:text-zinc-50">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
    </div>
  );
}
