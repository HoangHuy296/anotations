/**
 * A recording stand-in for the BullMQ client, passed through the existing
 * `EnqueueOptions.createQueue` seam. Tests that create real Jobs must not push
 * them into the live Redis queue: the running dev worker would claim and mutate
 * them mid-test. It also lets a test assert the exact payload that would be sent.
 */
export type RecordedQueueAdd = { name: string; payload: unknown; options?: { jobId?: string } };

export function recordingQueue(options: { failOnAdd?: boolean } = {}) {
  const adds: RecordedQueueAdd[] = [];
  const enqueueOptions = {
    createQueue: () => ({
      queue: {
        add: async (name: string, payload: unknown, addOptions?: { jobId?: string }) => {
          if (options.failOnAdd) throw new Error("queue unavailable");
          adds.push({ name, payload, options: addOptions });
        },
      },
      close: async () => undefined,
    }),
  };
  return { adds, enqueueOptions };
}
