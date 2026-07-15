import "server-only";

import { queueNameForJobType, type SupportedQueueJobType } from "@fieldframe/queue";
import { JobType } from "@internal/db";

export function resolveQueueName(type: JobType): string | null {
  return queueNameForJobType(type);
}

export function isSupportedQueueJobType(type: JobType): type is JobType & SupportedQueueJobType {
  return resolveQueueName(type) !== null;
}
