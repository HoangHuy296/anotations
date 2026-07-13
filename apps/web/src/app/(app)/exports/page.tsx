import { Export } from "@phosphor-icons/react/dist/ssr";

import { AppShell } from "@/components/layout/app-shell";

export default function ExportsPage() {
  return (
    <AppShell currentPath="/exports">
      <div className="grid min-h-[calc(100dvh-64px)] place-items-center px-4 py-8">
        <div className="max-w-md text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-sky-50 text-sky-700">
            <Export aria-hidden="true" size={26} weight="duotone" />
          </span>
          <h1 className="mt-5 text-2xl font-bold tracking-[-0.03em]">
            Annotation exports
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            JSON and CSV export jobs are planned for Phase 9.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
