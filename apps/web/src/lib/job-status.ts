import { JobStatus } from "@internal/db";

type JobStatusClass = "terminal" | "non-terminal";

/** Exhaustive against Prisma's current JobStatus enum. Add a classification when schema adds a status. */
const CLASSIFICATION = {
  [JobStatus.QUEUED]: "non-terminal",
  [JobStatus.RUNNING]: "non-terminal",
  [JobStatus.RETRYING]: "non-terminal",
  [JobStatus.CANCELING]: "non-terminal",
  [JobStatus.COMPLETED]: "terminal",
  [JobStatus.FAILED]: "terminal",
  [JobStatus.CANCELED]: "terminal",
} as const satisfies Record<JobStatus, JobStatusClass>;

export const TERMINAL_JOB_STATUSES = (Object.keys(CLASSIFICATION) as JobStatus[])
  .filter((status) => CLASSIFICATION[status] === "terminal");

export const NON_TERMINAL_JOB_STATUSES = (Object.keys(CLASSIFICATION) as JobStatus[])
  .filter((status) => CLASSIFICATION[status] === "non-terminal");
