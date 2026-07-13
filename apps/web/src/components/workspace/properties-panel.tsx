import {
  ClockCounterClockwise,
  ImageSquare,
  Info,
  Tag,
} from "@phosphor-icons/react/dist/ssr";
import type { AssetStatus } from "@internal/db";

import { Badge } from "@/components/ui/badge";
import { imageStatusPresentation } from "@/lib/image-status";

type PropertiesPanelProps = {
  image: {
    filename: string;
    path: string;
    width: number | null;
    height: number | null;
    sizeBytes: bigint | null;
    giteaSha: string;
    status: AssetStatus;
    annotationCount: number;
  } | null;
};

export function PropertiesPanel({ image }: PropertiesPanelProps) {
  if (!image) {
    return (
      <aside className="grid min-h-64 place-items-center border-l border-zinc-200 bg-white px-6 text-center">
        <div>
          <ImageSquare
            aria-hidden="true"
            className="mx-auto text-zinc-300"
            size={26}
            weight="duotone"
          />
          <p className="mt-3 text-xs font-semibold text-zinc-600">
            No image details
          </p>
        </div>
      </aside>
    );
  }

  const presentation = imageStatusPresentation[image.status];

  return (
    <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 p-4">
        <div className="flex items-center gap-2">
          <Tag aria-hidden="true" size={17} className="text-sky-600" />
          <h2 className="text-sm font-bold text-zinc-950">Annotation</h2>
          <Badge variant="neutral" className="ml-auto">
            Phase 7
          </Badge>
        </div>
        <p className="mt-4 text-xs leading-5 text-zinc-500">
          Bounding-box properties and label assignment arrive next. Canvas
          viewport changes are never persisted as annotations.
        </p>
      </div>

      <div className="border-b border-zinc-200 p-4">
        <div className="flex items-center gap-2">
          <Info aria-hidden="true" size={17} className="text-zinc-400" />
          <h2 className="text-sm font-bold text-zinc-950">Image details</h2>
          <Badge variant={presentation.variant} className="ml-auto">
            {presentation.label}
          </Badge>
        </div>
        <p className="mt-4 break-all text-xs font-semibold text-zinc-800">
          {image.filename}
        </p>
        <p className="mt-1 break-all font-mono text-[10px] leading-4 text-zinc-400">
          {image.path}
        </p>
        <dl className="mt-5 space-y-3 text-xs">
          <Detail
            label="Dimensions"
            value={
              image.width && image.height
                ? `${image.width} × ${image.height}`
                : "Detected on load"
            }
          />
          <Detail label="File size" value={formatBytes(image.sizeBytes)} />
          <Detail label="Annotations" value={String(image.annotationCount)} />
          <Detail label="Gitea SHA" value={image.giteaSha.slice(0, 10)} />
        </dl>
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2">
          <ClockCounterClockwise
            aria-hidden="true"
            size={17}
            className="text-zinc-400"
          />
          <h2 className="text-sm font-bold text-zinc-950">Action history</h2>
        </div>
        <div className="mt-4 rounded-xl border border-dashed border-zinc-200 p-4 text-center">
          <p className="text-xs font-medium text-zinc-500">
            No annotation actions yet
          </p>
          <p className="mt-1 text-[11px] leading-4 text-zinc-400">
            Viewport pan and zoom are intentionally excluded.
          </p>
        </div>
      </div>
    </aside>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="max-w-[150px] truncate font-mono text-zinc-700">{value}</dd>
    </div>
  );
}

function formatBytes(bytes: bigint | null) {
  if (bytes === null) return "Unknown";
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
