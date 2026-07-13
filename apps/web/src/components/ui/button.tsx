import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border text-sm font-semibold transition-[background-color,color,border-color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-45 active:translate-y-px",
  {
    variants: {
      variant: {
        primary:
          "border-sky-600 bg-sky-600 px-4 text-white shadow-[0_8px_24px_-12px_rgba(2,132,199,0.65)] hover:border-sky-700 hover:bg-sky-700",
        secondary:
          "border-zinc-200 bg-white px-4 text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50",
        ghost:
          "border-transparent bg-transparent px-3 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950",
        icon:
          "size-10 min-h-10 border-zinc-200 bg-white p-0 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950",
      },
      size: {
        default: "h-10",
        sm: "h-9 min-h-9 rounded-lg px-3 text-xs",
        lg: "h-11 min-h-11 px-5",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({
  asChild = false,
  className,
  variant,
  size,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
