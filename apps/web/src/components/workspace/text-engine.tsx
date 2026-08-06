import { TextT } from "@phosphor-icons/react/dist/ssr";

export function TextEngine({ asset }: { asset: { filename: string; description: string | null } }) {
  return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-950 px-6 text-center text-zinc-100 lg:min-h-0"><div className="max-w-sm"><TextT className="mx-auto text-amber-300" size={30} weight="duotone" /><p className="mt-3 text-sm font-semibold">Text workspace</p><p className="mt-1 text-xs leading-5 text-zinc-500">{asset.filename} is available as a read-only Asset. Text editing has its own future modality contract.</p></div></section>;
}
