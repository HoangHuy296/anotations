import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type JobTempWorkspace = {
  path: string;
  close: () => Promise<void>;
};

function workspacePrefix(jobId: string) {
  // The Job id never reaches a browser path. Still constrain it so this helper
  // cannot turn arbitrary data into a path segment.
  return `fieldframe-media-${jobId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96)}-`;
}

export async function createJobTempWorkspace(jobId: string): Promise<JobTempWorkspace> {
  const path = await mkdtemp(join(tmpdir(), workspacePrefix(jobId)));
  let closing: Promise<void> | undefined;
  return {
    path,
    close: () => {
      closing ??= rm(path, { recursive: true, force: true });
      return closing;
    },
  };
}

export async function withJobTempWorkspace<T>(jobId: string, run: (workspace: JobTempWorkspace) => Promise<T>): Promise<T> {
  const workspace = await createJobTempWorkspace(jobId);
  try {
    return await run(workspace);
  } finally {
    await workspace.close();
  }
}
