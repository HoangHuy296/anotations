import { LockKey } from "@phosphor-icons/react/dist/ssr";

export default async function UnauthorizedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const configurationError = reason === "configuration";

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-zinc-50 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-7 text-center shadow-[0_24px_70px_-40px_rgba(24,24,27,0.35)]">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-zinc-100 text-zinc-700">
          <LockKey aria-hidden="true" size={25} weight="duotone" />
        </span>
        <h1 className="mt-5 text-2xl font-bold tracking-[-0.03em] text-zinc-950">
          {configurationError
            ? "Authentication is not configured"
            : "Authentication required"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500">
          {configurationError
            ? "Configure the trusted reverse-proxy secret before exposing this deployment."
            : "Open Annotation Platform through the authenticated reverse proxy, or configure DEV_AUTH_EMAIL during local development."}
        </p>
      </div>
    </main>
  );
}
