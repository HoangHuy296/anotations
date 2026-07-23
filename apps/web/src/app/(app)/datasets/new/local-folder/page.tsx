import { LocalFolderImportForm } from "@/components/imports/local-folder-import-form";
import { AppShell } from "@/components/layout/app-shell";

export default function LocalFolderImportPage() {
  return (
    <AppShell currentPath="/datasets/new/local-folder">
      <LocalFolderImportForm />
    </AppShell>
  );
}
