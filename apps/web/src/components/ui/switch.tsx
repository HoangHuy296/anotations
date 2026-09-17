"use client";

import { cn } from "@/lib/utils";

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  className?: string;
};

/** A plain accessible toggle -- no new dependency; `role="switch"` plus a
 * visually hidden label keeps it usable without a pointer. */
function Switch({ checked, onCheckedChange, disabled, label, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-45",
        checked ? "border-sky-600 bg-sky-600" : "border-zinc-300 bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-700",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-4 translate-x-1 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-6",
        )}
      />
    </button>
  );
}

export { Switch };
