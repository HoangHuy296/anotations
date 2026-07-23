import {
  ArrowSquareOut,
  Export,
  GithubLogo,
  House,
  Tag,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import type { ReactNode } from "react";

import { AppMark } from "@/components/layout/app-mark";
import { DatasetNavigationGroup } from "@/components/layout/dataset-navigation-group";
import { AvatarMenu } from "@/components/auth/avatar-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getRequestActor } from "@/lib/auth";

const navigation = [
  { href: "/dashboard", label: "Overview", icon: House },
  { href: "/labels", label: "Labels", icon: Tag },
  { href: "/exports", label: "Exports", icon: Export },
];

type AppShellProps = {
  children: ReactNode;
  currentPath?: string;
};

export async function AppShell({
  children,
  currentPath = "/dashboard",
}: AppShellProps) {
  const actor = await getRequestActor();
  return (
    <div className="min-h-[100dvh] bg-zinc-50 text-zinc-950">
      <div className="mx-auto grid min-h-[100dvh] max-w-[1600px] grid-cols-1 bg-white lg:grid-cols-[236px_minmax(0,1fr)]">
        <aside className="hidden border-r border-zinc-200 bg-zinc-50/70 px-4 py-5 lg:flex lg:flex-col">
          <AppMark className="px-2" />

          <nav className="mt-10 space-y-1" aria-label="Primary navigation">
            {navigation.slice(0, 1).map((item) => {
              const Icon = item.icon;
              const active = currentPath === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                    active
                      ? "bg-zinc-950 text-white"
                      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950",
                  )}
                >
                  <Icon aria-hidden="true" size={18} weight={active ? "fill" : "regular"} />
                  {item.label}
                </Link>
              );
            })}
            <DatasetNavigationGroup activePath={currentPath} />
            {navigation.slice(1).map((item) => {
              const Icon = item.icon;
              const active = currentPath === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                    active ? "bg-zinc-950 text-white" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950",
                  )}
                >
                  <Icon aria-hidden="true" size={18} weight={active ? "fill" : "regular"} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto rounded-2xl border border-zinc-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="grid size-9 place-items-center rounded-xl bg-zinc-100 text-zinc-700">
                <GithubLogo aria-hidden="true" size={19} weight="fill" />
              </span>
              <Badge variant="success">Connected</Badge>
            </div>
            <p className="mt-4 text-sm font-semibold text-zinc-900">
              Gitea source
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              Server credentials are configured and remain private.
            </p>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="flex h-16 items-center justify-between border-b border-zinc-200 px-4 sm:px-6 lg:px-8">
            <AppMark compact className="lg:hidden" />
            <div className="hidden items-center gap-2 text-sm text-zinc-500 lg:flex">
              <span className="font-medium text-zinc-900">Workspace</span>
              <span className="text-zinc-300">/</span>
              <span>Production</span>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link href="/datasets">
                  Browse datasets
                  <ArrowSquareOut aria-hidden="true" size={15} />
                </Link>
              </Button>
              {actor ? <AvatarMenu actor={actor} /> : null}
            </div>
          </header>

          <main>{children}</main>
        </div>
      </div>
    </div>
  );
}
