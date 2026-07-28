import { redirect } from "next/navigation";

/** Legacy Phase-015 wizard URL. /datasets/imports is the single UI entry point. */
export default async function NewDatasetPage() {
  redirect("/datasets/imports");
}
