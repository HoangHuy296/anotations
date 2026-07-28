import { redirect } from "next/navigation";

/** Legacy URL only. All user-facing navigation targets /datasets/local-folder. */
export default function LocalFolderImportPage() {
  redirect("/datasets/local-folder");
}
