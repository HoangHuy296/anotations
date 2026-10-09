import assert from "node:assert/strict";
import test from "node:test";

import { aggregateImportItems } from "../src/import-item-accounting.js";

const ok = (itemId: string, disposition: "accepted" | "unchanged") => ({ message: "IMPORT_ITEM_SUCCEEDED", data: { itemId, disposition } });
const rejected = (itemId: string) => ({ message: "IMPORT_ITEM_REJECTED", data: { itemId, code: "UNSUPPORTED_MEDIA" } });
const retryable = (itemId: string) => ({ message: "IMPORT_ITEM_RETRYABLE", data: { itemId } });

test("accepted/unchanged derive from linked items and the stable success events only", () => {
  const result = aggregateImportItems({ total: 4, linkedItemIds: ["a", "b", "c"], events: [ok("a", "accepted"), ok("b", "accepted"), ok("c", "unchanged"), ok("ghost", "accepted")] });
  assert.deepEqual(result, { accepted: 2, unchanged: 1, rejected: 0, retryable: 0, verifying: 0, unprocessed: 1, completed: 3, total: 4 });
});

test("a verifying item is neither rejected, retryable nor unprocessed, and a stale retryable/rejected event for it is ignored", () => {
  const result = aggregateImportItems({ total: 3, linkedItemIds: ["a"], events: [ok("a", "accepted"), retryable("b"), rejected("c")], verifyingItemIds: ["b", "c"] });
  assert.deepEqual(result, { accepted: 1, unchanged: 0, rejected: 0, retryable: 0, verifying: 2, unprocessed: 0, completed: 1, total: 3 });
});

test("rejected wins over retryable; linked items are never counted as rejected or retryable; unprocessed never goes negative", () => {
  const result = aggregateImportItems({ total: 3, linkedItemIds: ["a"], events: [rejected("b"), retryable("b"), retryable("c"), rejected("a"), retryable("a")] });
  assert.deepEqual(result, { accepted: 0, unchanged: 1, rejected: 1, retryable: 1, verifying: 0, unprocessed: 0, completed: 1, total: 3 });
  assert.equal(aggregateImportItems({ total: 0, linkedItemIds: ["a", "b"], events: [] }).unprocessed, 0);
});

test("the aggregate is a pure function of its inputs (replay-stable, order-independent)", () => {
  const events = [ok("a", "accepted"), rejected("b"), retryable("c"), ok("d", "unchanged")];
  const one = aggregateImportItems({ total: 6, linkedItemIds: ["a", "d"], events, verifyingItemIds: ["e"] });
  const two = aggregateImportItems({ total: 6, linkedItemIds: ["d", "a"], events: [...events].reverse(), verifyingItemIds: ["e"] });
  assert.deepEqual(one, two);
  assert.deepEqual(one, { accepted: 1, unchanged: 1, rejected: 1, retryable: 1, verifying: 1, unprocessed: 1, completed: 2, total: 6 });
});
