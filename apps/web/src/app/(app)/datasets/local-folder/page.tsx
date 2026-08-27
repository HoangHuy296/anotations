import { LocalFolderImportForm } from "@/components/imports/local-folder-import-form";
import { AppShell } from "@/components/layout/app-shell";

/** Canonical browser entry point for creating a dataset from local files or a folder. */
export default function LocalFolderImportPage() {
  return (
    <AppShell currentPath="/datasets/local-folder">
      <LocalFolderImportForm />
    </AppShell>
  );
}
