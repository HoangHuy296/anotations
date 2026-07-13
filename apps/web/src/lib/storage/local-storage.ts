import "server-only";

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  StorageProvider,
  StoredObject,
} from "@/lib/storage/storage-provider";

const storageRoot = path.join(process.cwd(), ".data", "storage");

function resolveKey(key: string) {
  if (!/^[A-Za-z0-9/_-]+$/.test(key)) {
    throw new Error("Storage key contains unsupported characters.");
  }

  const resolved = path.resolve(storageRoot, key);
  if (resolved !== storageRoot && !resolved.startsWith(`${storageRoot}${path.sep}`)) {
    throw new Error("Storage key escapes the configured root.");
  }

  return resolved;
}

class LocalStorageProvider implements StorageProvider {
  async exists(key: string) {
    try {
      await stat(resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(resolveKey(key)));
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async put(
    key: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<StoredObject> {
    const target = resolveKey(key);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, target);

    return {
      key,
      size: data.byteLength,
      contentType,
    };
  }

  async delete(key: string) {
    await rm(resolveKey(key), { force: true });
  }
}

export const localStorageProvider = new LocalStorageProvider();
