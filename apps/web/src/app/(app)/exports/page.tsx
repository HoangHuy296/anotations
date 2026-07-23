import { Export } from "@phosphor-icons/react/dist/ssr";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { ExportForm } from "@/components/exports/export-form";
import { getRequestActor } from "@/lib/auth";
import { db, isDatabaseConfigured } from "@/lib/db";

export default async function ExportsPage() {
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const datasets = isDatabaseConfigured()
    ? await db.dataset.findMany({
      where: { deletedAt: null, archivedAt: null, OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    })
    : [];
  return (
    <AppShell currentPath="/exports">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <header className="border-b border-zinc-200 pb-7">
          <div className="flex items-center gap-2 text-sky-700"><Export aria-hidden="true" size={18} weight="duotone" /><span className="text-xs font-bold uppercase tracking-[0.14em]">Exports</span></div>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-zinc-950">Annotation exports</h1>
          <p className="mt-2 max-w-[65ch] text-sm leading-6 text-zinc-500">Generate an authorized, asynchronous JSON manifest for a dataset you can access.</p>
        </header>
        <ExportForm datasets={datasets} />
      </div>
    </AppShell>
  );
}
