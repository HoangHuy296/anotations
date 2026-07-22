/*
  Warnings:

  - You are about to drop the column `version` on the `Annotation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Annotation" DROP COLUMN "version",
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;
