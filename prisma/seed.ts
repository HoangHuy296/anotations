import { PrismaClient, UserRole } from "../lib/generated/prisma/client";

const prisma = new PrismaClient();

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

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const datasetId = process.env.SEED_DATASET_ID?.trim();

  if (adminEmail) {
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: {
        name: process.env.SEED_ADMIN_NAME?.trim() || "Development Operator",
        role: UserRole.ADMIN,
      },
      create: {
        email: adminEmail,
        name: process.env.SEED_ADMIN_NAME?.trim() || "Development Operator",
        role: UserRole.ADMIN,
      },
    });
  }

  if (datasetId) {
    const dataset = await prisma.dataset.findUnique({
      where: { id: datasetId },
      select: { id: true },
    });

    if (!dataset) {
      throw new Error("SEED_DATASET_ID does not identify an existing dataset.");
    }

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
  }

  console.log(
    `Seeded${datasetId ? ` ${labels.length} labels` : " no labels"}${adminEmail ? " and one administrator" : ""}.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("Database seed failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
