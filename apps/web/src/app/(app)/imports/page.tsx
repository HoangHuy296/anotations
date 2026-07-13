import { TrayArrowDown } from "@phosphor-icons/react/dist/ssr";

import { AppShell } from "@/components/layout/app-shell";
import { ImportForm } from "@/components/imports/import-form";

export default function ImportsPage() {
  return (
    <AppShell currentPath="/imports">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <header className="border-b border-zinc-200 pb-7">
          <div className="flex items-center gap-2 text-sky-700">
            <TrayArrowDown aria-hidden="true" size={18} weight="duotone" />
            <span className="text-xs font-bold uppercase tracking-[0.14em]">
              Gitea import
            </span>
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-zinc-950">
            Import a repository folder
          </h1>
          <p className="mt-2 max-w-[65ch] text-sm leading-6 text-zinc-500">
            Preview the selected tree first. Fieldframe writes repository,
            dataset, and image records only after the preview passes safety
            limits.
          </p>
        </header>
        <div className="mt-7">
          <ImportForm />
        </div>
      </div>
    </AppShell>
  );
}
