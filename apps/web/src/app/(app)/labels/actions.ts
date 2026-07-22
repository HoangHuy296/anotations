"use server";

import { revalidatePath } from "next/cache";

import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db, isDatabaseConfigured } from "@/lib/db";
import { deleteUnreferencedLabel } from "@/lib/workspace/label-management";
import {
  labelIdSchema,
  labelSchema,
  type LabelInput,
} from "@/lib/validation/label";

export type LabelField = keyof LabelInput;

export type LabelActionResult = {
  success: boolean;
  message: string;
  fieldErrors?: Partial<Record<LabelField, string[]>>;
};

function unauthorizedResult(): LabelActionResult {
  return {
    success: false,
    message: "You need reviewer or administrator access to manage labels.",
  };
}

function databaseNotConfiguredResult(): LabelActionResult {
  return {
    success: false,
    message: "Configure DATABASE_URL and apply migrations before managing labels.",
  };
}

function invalidInputResult(
  fieldErrors: Partial<Record<LabelField, string[]>>,
): LabelActionResult {
  return {
    success: false,
    message: "Review the highlighted fields and try again.",
    fieldErrors,
  };
}

function databaseErrorResult(error: unknown): LabelActionResult {
  console.error("Label mutation failed.", error);
  return {
    success: false,
    message: "The label could not be saved. Try again.",
  };
}

function readLabelInput(formData: FormData) {
  return labelSchema.safeParse({
    datasetId: formData.get("datasetId"),
    name: formData.get("name"),
    color: formData.get("color"),
    description: formData.get("description"),
    hotkey: formData.get("hotkey"),
  });
}

async function hasCaseInsensitiveNameConflict(
  datasetId: string,
  name: string,
  excludeId?: string,
) {
  const label = await db.label.findFirst({
    where: {
      datasetId,
      name: {
        equals: name,
        mode: "insensitive",
      },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });

  return Boolean(label);
}

export async function createLabelAction(
  formData: FormData,
): Promise<LabelActionResult> {
  if (!isDatabaseConfigured()) {
    return databaseNotConfiguredResult();
  }

  const actor = await getRequestActor();

  if (!actor) {
    return unauthorizedResult();
  }

  const parsed = readLabelInput(formData);

  if (!parsed.success) {
    return invalidInputResult(parsed.error.flatten().fieldErrors);
  }
  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "label.manage");
  if (!access || access.forbidden) return unauthorizedResult();

  try {
    if (await hasCaseInsensitiveNameConflict(parsed.data.datasetId, parsed.data.name)) {
      return invalidInputResult({
        name: ["A label with this name already exists."],
      });
    }

    await db.label.create({
      data: {
        datasetId: parsed.data.datasetId,
        normalizedName: parsed.data.name.toLocaleLowerCase(),
        name: parsed.data.name,
        color: parsed.data.color,
        description: parsed.data.description || null,
        hotkey: parsed.data.hotkey || null,
      },
    });

    revalidatePath("/labels");
    return {
      success: true,
      message: `Created ${parsed.data.name}.`,
    };
  } catch (error: unknown) {
    return databaseErrorResult(error);
  }
}

export async function updateLabelAction(
  id: string,
  formData: FormData,
): Promise<LabelActionResult> {
  if (!isDatabaseConfigured()) {
    return databaseNotConfiguredResult();
  }

  const actor = await getRequestActor();

  if (!actor) {
    return unauthorizedResult();
  }

  const parsedId = labelIdSchema.safeParse(id);
  const parsed = readLabelInput(formData);

  if (!parsedId.success) {
    return {
      success: false,
      message: "The selected label is invalid.",
    };
  }

  if (!parsed.success) {
    return invalidInputResult(parsed.error.flatten().fieldErrors);
  }
  const existing = await db.label.findFirst({ where: { id: parsedId.data, datasetId: parsed.data.datasetId }, select: { id: true } });
  if (!existing) return { success: false, message: "This label no longer exists." };
  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "label.manage");
  if (!access || access.forbidden) return unauthorizedResult();

  try {
    if (
      await hasCaseInsensitiveNameConflict(
        parsed.data.datasetId,
        parsed.data.name,
        parsedId.data,
      )
    ) {
      return invalidInputResult({
        name: ["A label with this name already exists."],
      });
    }

    const updated = await db.label.updateMany({
      where: { id: parsedId.data, datasetId: parsed.data.datasetId },
      data: {
        normalizedName: parsed.data.name.toLocaleLowerCase(),
        name: parsed.data.name,
        color: parsed.data.color,
        description: parsed.data.description || null,
        hotkey: parsed.data.hotkey || null,
      },
    });

    if (updated.count === 0) {
      return {
        success: false,
        message: "This label no longer exists.",
      };
    }

    revalidatePath("/labels");
    return {
      success: true,
      message: `Updated ${parsed.data.name}.`,
    };
  } catch (error: unknown) {
    return databaseErrorResult(error);
  }
}

export async function deleteLabelAction(
  id: string,
): Promise<LabelActionResult> {
  if (!isDatabaseConfigured()) {
    return databaseNotConfiguredResult();
  }

  const actor = await getRequestActor();

  if (!actor) {
    return unauthorizedResult();
  }

  const parsedId = labelIdSchema.safeParse(id);

  if (!parsedId.success) {
    return {
      success: false,
      message: "The selected label is invalid.",
    };
  }

  try {
    const label = await db.label.findFirst({
      where: { id: parsedId.data },
      select: {
        name: true,
        datasetId: true,
      },
    });

    if (!label) {
      return {
        success: false,
        message: "This label no longer exists.",
      };
    }
    const deleted = await deleteUnreferencedLabel(actor, parsedId.data);
    if (!deleted.ok && deleted.status === 403) return unauthorizedResult();
    if (!deleted.ok && deleted.status === 404) {
      return { success: false, message: "This label no longer exists." };
    }
    if (!deleted.ok) {
      return {
        success: false,
        message: `${label.name} is assigned to an annotation and cannot be deleted.`,
      };
    }

    revalidatePath("/labels");
    return {
      success: true,
      message: `Deleted ${label.name}.`,
    };
  } catch (error: unknown) {
    return databaseErrorResult(error);
  }
}
