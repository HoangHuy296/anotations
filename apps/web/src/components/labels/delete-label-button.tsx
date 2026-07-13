"use client";

import { Trash } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteLabelAction } from "@/app/(app)/labels/actions";
import { Button } from "@/components/ui/button";

type DeleteLabelButtonProps = {
  id: string;
  name: string;
  annotationCount: number;
  canManage: boolean;
};

export function DeleteLabelButton({
  id,
  name,
  annotationCount,
  canManage,
}: DeleteLabelButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const disabled = !canManage || annotationCount > 0 || isPending;

  function handleDelete() {
    if (!window.confirm(`Delete "${name}"? This action cannot be undone.`)) {
      return;
    }

    setMessage(null);
    startTransition(() => {
      void deleteLabelAction(id).then((result) => {
        setMessage(result.message);
        if (result.success) {
          router.refresh();
        }
      });
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <span
        className="text-right text-[11px] leading-4 text-rose-600"
        aria-live="polite"
      >
        {message}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
        disabled={disabled}
        onClick={handleDelete}
        title={
          annotationCount > 0
            ? "Assigned labels cannot be deleted."
            : undefined
        }
      >
        <Trash aria-hidden="true" size={15} />
        {isPending ? "Deleting..." : "Delete"}
      </Button>
    </div>
  );
}
