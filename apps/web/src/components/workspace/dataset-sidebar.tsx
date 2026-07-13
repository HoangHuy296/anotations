import {
  CaretRight,
  Funnel,
  ImageSquare,
  MagnifyingGlass,
} from "@phosphor-icons/react/dist/ssr";
import type { AssetStatus } from "@internal/db";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  imageStatusOptions,
  imageStatusPresentation,
} from "@/lib/image-status";

type SidebarImage = {
  id: string;
  filename: string;
  path: string;
  width: number | null;
  height: number | null;
  status: AssetStatus;
};

type DatasetSidebarProps = {
  datasetId: string;
  images: SidebarImage[];
  totalImages: number;
  completedImages: number;
  selectedImageId: string | null;
  search: string;
  status: AssetStatus | "ALL";
};

export function DatasetSidebar({
  datasetId,
  images,
  totalImages,
  completedImages,
  selectedImageId,
  search,
  status,
}: DatasetSidebarProps) {
  const progress =
    totalImages === 0 ? 0 : Math.round((completedImages / totalImages) * 1000) / 10;

  return (
    <aside className="flex min-h-0 flex-col border-r border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 p-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
            Dataset
          </p>
          <p className="mt-1 text-sm font-semibold text-zinc-900">
            {totalImages} source image{totalImages === 1 ? "" : "s"}
          </p>
        </div>

        <form className="mt-3 space-y-2" method="get">
          <label className="flex h-10 items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100">
            <MagnifyingGlass
              aria-hidden="true"
              size={16}
              className="text-zinc-400"
            />
            <span className="sr-only">Search images</span>
            <input
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
              defaultValue={search}
              name="q"
              placeholder="Search files"
              type="search"
            />
          </label>
          <div className="flex gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2.5">
              <Funnel aria-hidden="true" size={15} className="text-zinc-400" />
              <span className="sr-only">Filter by status</span>
              <select
                className="min-w-0 flex-1 bg-transparent text-xs text-zinc-700 outline-none"
                defaultValue={status}
                name="status"
              >
                <option value="ALL">All statuses</option>
                {imageStatusOptions.map((option) => (
                  <option key={option} value={option}>
                    {imageStatusPresentation[option].label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="h-9 rounded-xl bg-zinc-950 px-3 text-xs font-semibold text-white transition-colors hover:bg-zinc-800"
              type="submit"
            >
              Apply
            </button>
          </div>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {images.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <ImageSquare
              aria-hidden="true"
              className="mx-auto text-zinc-300"
              size={26}
              weight="duotone"
            />
            <p className="mt-3 text-xs font-semibold text-zinc-600">
              No matching images
            </p>
            <p className="mt-1 text-[11px] leading-4 text-zinc-400">
              Adjust the filename or status filter.
            </p>
          </div>
        ) : (
          images.map((image, index) => {
            const selected = image.id === selectedImageId;
            const presentation = imageStatusPresentation[image.status];
            const params = new URLSearchParams();
            if (search) params.set("q", search);
            if (status !== "ALL") params.set("status", status);
            params.set("image", image.id);

            return (
              <Link
                key={image.id}
                href={`/workspace/${datasetId}?${params.toString()}`}
                className={`mb-1 flex w-full items-start gap-3 rounded-xl border p-2.5 text-left transition-colors ${
                  selected
                    ? "border-sky-200 bg-sky-50"
                    : "border-transparent hover:bg-zinc-50"
                }`}
              >
                <span
                  className={`grid size-11 shrink-0 place-items-center rounded-lg ${
                    selected
                      ? "bg-sky-100 text-sky-700"
                      : "bg-zinc-100 text-zinc-400"
                  }`}
                >
                  <ImageSquare aria-hidden="true" size={20} weight="duotone" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-zinc-900">
                      {image.filename}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-400">
                      {String(index + 1).padStart(4, "0")}
                    </span>
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant={presentation.variant}>
                      {presentation.label}
                    </Badge>
                    <span className="font-mono text-[9px] text-zinc-400">
                      {image.width && image.height
                        ? `${image.width} × ${image.height}`
                        : "dimensions pending"}
                    </span>
                  </span>
                </span>
                {selected && (
                  <CaretRight
                    aria-hidden="true"
                    className="mt-3 shrink-0 text-sky-600"
                    size={14}
                    weight="bold"
                  />
                )}
              </Link>
            );
          })
        )}
      </div>

      <div className="border-t border-zinc-200 px-4 py-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-zinc-500">Dataset progress</span>
          <span className="font-mono font-semibold text-zinc-900">
            {progress}%
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
          <div
            className="h-full rounded-full bg-sky-600"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </aside>
  );
}
