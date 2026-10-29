import { LinkBreak, UsersThree } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { JoinShareLinkButton } from "@/components/collaboration/join-share-link-button";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { getRequestActor } from "@/lib/auth";
import { previewShareLink } from "@/lib/collaboration/share-link-service";
import { shareLinkTokenSchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";

export default async function JoinSharedDatasetPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const { token } = await params;
  const parsed = shareLinkTokenSchema.safeParse(token);
  const preview = parsed.success ? await previewShareLink(actor, parsed.data) : null;

  return <AppShell currentPath="/datasets">
    <div className="mx-auto grid min-h-[60dvh] max-w-md place-items-center px-4 py-12">
      <section className="w-full rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        {preview ? <>
          <span className="grid size-12 place-items-center rounded-2xl bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300"><UsersThree aria-hidden="true" size={24} /></span>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">Dataset invitation</p>
          <h1 className="mt-1 text-xl font-bold tracking-[-0.02em] text-zinc-950 dark:text-zinc-50">{preview.datasetName}</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold text-zinc-800 dark:text-zinc-200">{preview.ownerName}</span> shared this dataset with you. You will join as a <span className="font-semibold text-zinc-800 dark:text-zinc-200">labeler</span> and see the assets assigned to you.
          </p>
          <div className="mt-6">
            {preview.alreadyMember
              ? <><p className="mb-3 text-center text-xs text-emerald-700 dark:text-emerald-400">You are already a member of this dataset.</p><Button asChild className="w-full" size="lg"><Link href={`/workspace/${preview.datasetId}`}>Open workspace</Link></Button></>
              : <JoinShareLinkButton token={token} />}
          </div>
          <p className="mt-4 text-center text-[11px] text-zinc-400">Signed in as {actor.email}</p>
        </> : <>
          <span className="grid size-12 place-items-center rounded-2xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800"><LinkBreak aria-hidden="true" size={24} /></span>
          <h1 className="mt-5 text-xl font-bold tracking-[-0.02em] text-zinc-950 dark:text-zinc-50">This link no longer works</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">It may have expired, been revoked, or reached its limit. Ask the dataset owner for a new share link.</p>
          <Button asChild className="mt-6 w-full" size="lg" variant="secondary"><Link href="/datasets">Back to datasets</Link></Button>
        </>}
      </section>
    </div>
  </AppShell>;
}
