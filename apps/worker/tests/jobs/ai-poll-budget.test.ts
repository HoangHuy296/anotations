import assert from "node:assert/strict";
import test from "node:test";

import { computePollDelay, hasExceededPollBudget } from "../../src/jobs/ai-poll.processor.js";
import { MAX_POLL_ATTEMPTS, MAX_POLL_DURATION_MS, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS } from "../../src/jobs/ai-poll-constants.js";

test("computePollDelay grows exponentially from the base delay", () => {
  assert.equal(computePollDelay(0), POLL_BASE_DELAY_MS);
  assert.equal(computePollDelay(1), POLL_BASE_DELAY_MS * 2);
  assert.equal(computePollDelay(2), POLL_BASE_DELAY_MS * 4);
});

test("computePollDelay caps at POLL_MAX_DELAY_MS", () => {
  assert.equal(computePollDelay(20), POLL_MAX_DELAY_MS);
  assert.equal(computePollDelay(1_000), POLL_MAX_DELAY_MS);
});

test("computePollDelay never returns less than the base delay for a non-negative pollAttempts", () => {
  assert.equal(computePollDelay(0), POLL_BASE_DELAY_MS);
});

test("hasExceededPollBudget trips once pollAttempts reaches MAX_POLL_ATTEMPTS", () => {
  const now = new Date();
  assert.equal(hasExceededPollBudget({ pollAttempts: MAX_POLL_ATTEMPTS - 1, createdAt: now }), false);
  assert.equal(hasExceededPollBudget({ pollAttempts: MAX_POLL_ATTEMPTS, createdAt: now }), true);
});

test("hasExceededPollBudget trips once MAX_POLL_DURATION_MS has elapsed since createdAt, regardless of pollAttempts", () => {
  const longAgo = new Date(Date.now() - MAX_POLL_DURATION_MS - 1_000);
  assert.equal(hasExceededPollBudget({ pollAttempts: 0, createdAt: longAgo }), true);
});

test("hasExceededPollBudget is false for a fresh task well within both budgets", () => {
  assert.equal(hasExceededPollBudget({ pollAttempts: 1, createdAt: new Date() }), false);
});
