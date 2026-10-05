"use client";

export default function WorkspaceError({ reset }: { reset: () => void }) {
  return <main role="alert" className="grid min-h-100dvh place-items-center bg-zinc-50 px-4"><div className="max-w-md text-center"><h1 className="text-xl font-bold text-zinc-950">Workspace could not be loaded</h1><p className="mt-2 text-sm leading-6 text-zinc-600">Dataset state is unavailable. Try again before continuing annotation.</p><button type="button" onClick={reset} className="mt-5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600">Try again</button></div></main>;
}
