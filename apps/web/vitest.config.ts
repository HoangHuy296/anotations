import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // Mirrors tsconfig.json's "paths" mapping, which vitest does not read.
      "@internal/db": path.resolve(import.meta.dirname, "../../lib/generated/prisma/client.ts"),
      // `server-only` is not a project dependency; this is vitest's
      // equivalent of `tests/auth-ownership/register-server-only.cjs`.
      "server-only": path.resolve(import.meta.dirname, "tests/setup/server-only-shim.ts"),
    },
  },
});
