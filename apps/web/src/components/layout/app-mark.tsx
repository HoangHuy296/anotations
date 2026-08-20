import { BoundingBox } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

type AppMarkProps = {
  compact?: boolean;
  className?: string;
};

export function AppMark({ compact = false, className }: AppMarkProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-950 text-white shadow-[0_10px_30px_-16px_rgba(24,24,27,0.8)]">
        <BoundingBox aria-hidden="true" size={20} weight="bold" />
      </span>
      {!compact && (
        <span className="leading-none">
          <span className="block text-sm font-bold tracking-[-0.02em] text-zinc-950">
            Annotation Platform
          </span>
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-400">
            Annotation desk
          </span>
        </span>
      )}
    </div>
  );
}
