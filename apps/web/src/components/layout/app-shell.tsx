import {
  ArrowSquareOut,
  Export,
  House,
  Tag,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import type { ReactNode } from "react";

import { AppMark } from "@/components/layout/app-mark";
import { DatasetNavigationGroup } from "@/components/layout/dataset-navigation-group";
import { SourceConnectionsPanel } from "@/components/layout/source-connections-panel";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { AvatarMenu } from "@/components/auth/avatar-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getRequestActor } from "@/lib/auth";
import { getGiteaConnectionCount } from "@/lib/source-provider-summary";
import { readAccountPreferences } from "@/lib/validation/account-preferences";

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
  const savedGiteaConnections = actor ? await getGiteaConnectionCount(actor.id) : null;
  // Account > Accessibility preferences, applied app-wide from the same
  // `getRequestActor()` call every page already makes -- no extra query.
  // The CSS these attributes drive lives in globals.css.
  const preferences = readAccountPreferences(actor?.preferences);
  const accessibility = preferences.accessibility;
  const pathSegments = currentPath
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((segment) => ({
      raw: segment,
      label: segment.length > 18 ? "Details" : segment.replaceAll("-", " "),
    }));
  return (
    <div
      className="min-h-[100dvh] bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50"
      data-theme={preferences.theme === "dark" ? "dark" : undefined}
      data-reduce-motion={accessibility.reduceMotion || undefined}
      data-high-contrast={accessibility.highContrast || undefined}
      data-large-text={accessibility.largeText || undefined}
    >
      <div className="mx-auto grid min-h-[100dvh] max-w-[1600px] grid-cols-1 bg-white lg:grid-cols-[236px_minmax(0,1fr)] dark:bg-zinc-950">
        <aside className="hidden border-r border-zinc-200 bg-zinc-50/70 px-4 py-5 lg:sticky lg:top-0 lg:flex lg:h-[100dvh] lg:flex-col lg:overflow-y-auto dark:border-zinc-800 dark:bg-zinc-900/40">
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
                      ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50",
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
                    active
                      ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50",
                  )}
                >
                  <Icon aria-hidden="true" size={18} weight={active ? "fill" : "regular"} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto pt-10"><SourceConnectionsPanel savedGiteaConnections={savedGiteaConnections} /></div>
        </aside>

        <div className="min-w-0">
          <header className="flex h-16 items-center justify-between border-b border-zinc-200 px-4 sm:px-6 lg:px-8 dark:border-zinc-800">
            <AppMark compact className="lg:hidden" />
            <div className="hidden min-w-0 items-center gap-2 text-sm text-zinc-500 lg:flex dark:text-zinc-400" aria-label="Current page">
              <Link className="font-medium text-zinc-900 hover:text-sky-700 dark:text-zinc-100 dark:hover:text-sky-400" href="/dashboard">Workspace</Link>
              {pathSegments.map((segment, index) => (
                <span className="flex min-w-0 items-center gap-2" key={`${segment.raw}-${index}`}>
                  <span className="text-zinc-300 dark:text-zinc-700">/</span>
                  <span className={cn("truncate capitalize", index === pathSegments.length - 1 && "font-medium text-zinc-900 dark:text-zinc-100")}>
                    {segment.label}
                  </span>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link href="/datasets">
                  Browse datasets
                  <ArrowSquareOut aria-hidden="true" size={15} />
                </Link>
              </Button>
              <ThemeToggle initialTheme={preferences.theme} />
              {actor ? <NotificationBell /> : null}
              {actor ? <AvatarMenu actor={actor} /> : null}
            </div>
          </header>

          <main>{children}</main>
          <div className="px-4 pb-6 sm:px-6 lg:hidden"><SourceConnectionsPanel savedGiteaConnections={savedGiteaConnections} /></div>
        </div>
      </div>
    </div>
  );
}
