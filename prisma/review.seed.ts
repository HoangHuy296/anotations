import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

import { PrismaClient, UserRole } from "../lib/generated/prisma/client";

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback);

const DEFAULT_DATASET_NAME = "Review Demo Dataset";

const labels = [
  {
    name: "Pedestrian",
    color: "#0EA5E9",
    description: "A visible person, including partially occluded pedestrians.",
    hotkey: "1",
  },
  {
    name: "Vehicle",
    color: "#F59E0B",
    description: "Cars, vans, buses, trucks, and other road vehicles.",
    hotkey: "2",
  },
  {
    name: "Bicycle",
    color: "#10B981",
    description: "A bicycle, whether parked or currently being ridden.",
    hotkey: "3",
  },
  {
    name: "Traffic sign",
    color: "#E11D48",
    description: "Regulatory, warning, and informational road signs.",
    hotkey: "4",
  },
];

// Mirrors apps/web/src/lib/auth.ts hashPassword exactly, so the seeded
// credential works with the existing, unmodified login flow. Reproduced here
// rather than imported because auth.ts is a "server-only" Next.js module and
// pulls in next/headers and the @/ path alias, neither of which resolve when
// this script runs standalone via tsx.
async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = Buffer.from((await scrypt(password, salt, 64)) as ArrayBuffer).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  const datasetName = process.env.SEED_DATASET_NAME?.trim() || DEFAULT_DATASET_NAME;

  if (!adminEmail || !adminPassword) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are both required for the review seed.",
    );
  }

  const passwordHash = await hashPassword(adminPassword);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: process.env.SEED_ADMIN_NAME?.trim() || "Review Operator",
      role: UserRole.ADMIN,
      passwordHash,
    },
    create: {
      email: adminEmail,
      name: process.env.SEED_ADMIN_NAME?.trim() || "Review Operator",
      role: UserRole.ADMIN,
      passwordHash,
    },
  });

  // Dataset ids are Prisma-generated cuids (enforced by z.string().cuid()
  // validation across the API), so this looks the demo dataset up by owner
  // + name rather than accepting a fixed id from the environment.
  const dataset =
    (await prisma.dataset.findFirst({
      where: { ownerId: admin.id, name: datasetName },
    })) ??
    (await prisma.dataset.create({
      data: { ownerId: admin.id, name: datasetName },
    }));

  await prisma.$transaction(
    labels.map((label) =>
      prisma.label.upsert({
        where: {
          datasetId_normalizedName: {
            datasetId: dataset.id,
            normalizedName: label.name.toLocaleLowerCase(),
          },
        },
        update: {
          color: label.color,
          description: label.description,
          hotkey: label.hotkey,
        },
        create: {
          datasetId: dataset.id,
          normalizedName: label.name.toLocaleLowerCase(),
          ...label,
        },
      }),
    ),
  );

  console.log(
    `Review seed complete: admin ${admin.email}, dataset "${dataset.name}" (${dataset.id}), ${labels.length} labels.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("Review database seed failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
