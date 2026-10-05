import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { VisualizationShell } from "@/components/visualization/visualization-shell";
import { visualizationQuerySchema } from "@/lib/validation/visualization";
import { AppShell } from "@/components/layout/app-shell";
import { getRequestActor } from "@/lib/auth";
import { readVisualizationAccess } from "@/lib/visualization/access";

export const dynamic = "force-dynamic";

export default async function VisualizationPage({ params, searchParams }: { params: Promise<{ datasetId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const { datasetId } = await params;
  const result = await readVisualizationAccess(await getRequestActor(), datasetId);
  if (result.kind === "not-found") notFound();
  if (result.kind === "redirect") redirect(result.destination);

  const { tab } = visualizationQuerySchema.parse(await searchParams);
  return <AppShell currentPath="/datasets">
    <VisualizationShell dataset={result.dataset} tab={tab} />
  </AppShell>;
}
