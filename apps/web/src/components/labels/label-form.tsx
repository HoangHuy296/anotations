"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, FloppyDisk, Palette, Plus } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  createLabelAction,
  updateLabelAction,
  type LabelActionResult,
} from "@/app/(app)/labels/actions";
import { Button } from "@/components/ui/button";
import { labelSchema, type LabelInput } from "@/lib/validation/label";

type LabelFormProps = {
  mode: "create" | "edit";
  canManage: boolean;
  datasetId: string;
  label?: {
    id: string;
    name: string;
    color: string;
    description: string | null;
    hotkey: string | null;
  };
};

const inputClassName =
  "mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition-[border-color,box-shadow] placeholder:text-zinc-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500";

export function LabelForm({ mode, canManage, datasetId, label }: LabelFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<LabelActionResult | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    control,
    formState: { errors, isDirty },
  } = useForm<LabelInput>({
    resolver: zodResolver(labelSchema),
    defaultValues: {
      datasetId,
      name: label?.name ?? "",
      color: label?.color ?? "#0EA5E9",
      description: label?.description ?? "",
      hotkey: label?.hotkey ?? "",
    },
  });
  const color = useWatch({ control, name: "color" });
  const [paletteOpen, setPaletteOpen] = useState(false);

  const submit = handleSubmit((values) => {
    setResult(null);
    const formData = new FormData();
    formData.set("datasetId", values.datasetId);
    formData.set("name", values.name);
    formData.set("color", values.color);
    formData.set("description", values.description);
    formData.set("hotkey", values.hotkey);

    startTransition(() => {
      const action =
        mode === "edit" && label
          ? updateLabelAction(label.id, formData)
          : createLabelAction(formData);

      void action.then((actionResult) => {
        setResult(actionResult);

        if (actionResult.fieldErrors) {
          for (const [field, messages] of Object.entries(
            actionResult.fieldErrors,
          )) {
            const message = messages?.[0];
            if (message) {
              setError(field as keyof LabelInput, {
                type: "server",
                message,
              });
            }
          }
        }

        if (actionResult.success) {
          if (mode === "create") {
            reset({
              datasetId,
              name: "",
              color: "#0EA5E9",
              description: "",
              hotkey: "",
            });
          } else {
            reset(values);
          }
          router.refresh();
        }
      });
    });
  });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <input type="hidden" {...register("datasetId")} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_116px_152px]">
        <Field label="Name" error={errors.name?.message}>
          <input
            {...register("name")}
            className={inputClassName}
            disabled={!canManage || isPending}
            placeholder="Pedestrian"
            autoComplete="off"
          />
        </Field>

        <Field label="Color" error={undefined}>
          <div className="relative mt-2">
            <button
              aria-controls={`label-color-palette-${label?.id ?? "new"}`}
              aria-expanded={paletteOpen}
              aria-haspopup="dialog"
              className="mt-0 grid h-10 w-full place-items-center rounded-xl border border-zinc-200 bg-white outline-none transition hover:border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50"
              disabled={!canManage || isPending}
              onClick={() => setPaletteOpen((open) => !open)}
              type="button"
              title="Choose label color"
            >
              <span
                className="size-5 rounded-md border border-black/10"
                style={{ backgroundColor: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : "#E4E4E7" }}
              />
              <span className="sr-only">Choose label color</span>
            </button>
            {paletteOpen ? (
              <div
                aria-label="Label color palette"
                className="absolute z-20 mt-2 grid w-48 grid-cols-6 gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl"
                id={`label-color-palette-${label?.id ?? "new"}`}
                role="dialog"
              >
                {LABEL_COLORS.map((value) => (
                  <button
                    aria-label={`Use ${value}`}
                    aria-pressed={color?.toUpperCase() === value}
                    className="grid size-6 place-items-center rounded-md border border-black/10 outline-none transition hover:scale-110 focus-visible:ring-2 focus-visible:ring-sky-400"
                    key={value}
                    onClick={() => {
                      setValue("color", value, { shouldDirty: true, shouldValidate: true });
                      setPaletteOpen(false);
                    }}
                    style={{ backgroundColor: value }}
                    type="button"
                  >
                    {color?.toUpperCase() === value ? <Check aria-hidden="true" className="text-white drop-shadow" size={13} weight="bold" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </Field>

        <Field label="Color code" error={errors.color?.message}>
          <input
            {...register("color")}
            className={`${inputClassName} font-mono uppercase`}
            disabled={!canManage || isPending}
            placeholder="#0EA5E9"
            autoComplete="off"
          />
        </Field>
      </div>

      <details className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-3 py-2" open={Boolean(label?.description || label?.hotkey)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-zinc-600">
          <Palette aria-hidden="true" size={14} />
          Advanced label metadata
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_116px]">
          <Field label="Description" error={errors.description?.message}>
            <textarea
              {...register("description")}
              className="mt-2 min-h-20 w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm leading-6 text-zinc-900 outline-none transition-[border-color,box-shadow] placeholder:text-zinc-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
              disabled={!canManage || isPending}
              placeholder="Describe when annotators should apply this label."
            />
          </Field>
          <Field label="Hotkey" error={errors.hotkey?.message}>
            <input
              {...register("hotkey")}
              className={`${inputClassName} font-mono uppercase`}
              disabled={!canManage || isPending}
              maxLength={1}
              placeholder="1"
              autoComplete="off"
            />
          </Field>
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className={`text-xs leading-5 ${
              result?.success ? "text-emerald-700" : "text-rose-700"
            }`}
            aria-live="polite"
          >
            {result?.message}
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={
              !canManage || isPending || (mode === "edit" && !isDirty)
            }
          >
            {result?.success && !isDirty ? (
              <Check aria-hidden="true" size={15} weight="bold" />
            ) : mode === "create" ? (
              <Plus aria-hidden="true" size={15} weight="bold" />
            ) : (
              <FloppyDisk aria-hidden="true" size={15} weight="bold" />
            )}
            {isPending
              ? "Saving..."
              : mode === "create"
                ? "Create label"
                : "Save changes"}
          </Button>
      </div>
    </form>
  );
}

const LABEL_COLORS = [
  "#0EA5E9", "#2563EB", "#4F46E5", "#7C3AED", "#9333EA", "#C026D3",
  "#DB2777", "#E11D48", "#EA580C", "#F97316", "#CA8A04", "#EAB308",
  "#65A30D", "#16A34A", "#059669", "#0F766E", "#0891B2", "#475569",
  "#334155", "#78350F", "#BE123C", "#A21CAF", "#1D4ED8", "#047857",
] as const;

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-zinc-700">{label}</span>
      {children}
      <span className="mt-1.5 block min-h-4 text-[11px] leading-4 text-rose-600">
        {error}
      </span>
    </label>
  );
}
