import {
  ArrowLeft,
  CaretDown,
  CloudCheck,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type WorkspaceHeaderProps = {
  datasetName: string;
  branch: string;
  repositoryFullName: string;
  rootPath: string;
};

export function WorkspaceHeader({
  datasetName,
  branch,
  repositoryFullName,
  rootPath,
}: WorkspaceHeaderProps) {
  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-3 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Button asChild variant="icon" aria-label="Back to dashboard">
          <Link href="/dashboard">
            <ArrowLeft aria-hidden="true" size={18} />
          </Link>
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-bold text-zinc-950">
              {datasetName}
            </h1>
            <Badge variant="info">{branch}</Badge>
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
            {repositoryFullName}
            {rootPath ? ` / ${rootPath}` : ""}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-2 text-xs text-zinc-500 sm:flex">
          <CloudCheck
            aria-hidden="true"
            className="text-emerald-600"
            size={17}
            weight="fill"
          />
          All changes saved
        </span>
        <Button variant="secondary" size="sm">
          Review
          <CaretDown aria-hidden="true" size={13} weight="bold" />
        </Button>
      </div>
    </header>
  );
}
