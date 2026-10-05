import Link from "next/link";

export default function WorkspaceNotFound() {
  return <main className="grid min-h-100dvh place-items-center bg-zinc-50 px-4"><div className="max-w-md text-center"><h1 className="text-xl font-bold text-zinc-950">Workspace not found</h1><p className="mt-2 text-sm leading-6 text-zinc-600">This dataset or selected asset is unavailable, or you do not have access.</p><Link href="/datasets" className="mt-5 inline-block rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white">Back to datasets</Link></div></main>;
}
