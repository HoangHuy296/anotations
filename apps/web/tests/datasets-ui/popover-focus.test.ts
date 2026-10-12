import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: a pure rule and source-contract checks, no database is opened).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shouldRestoreTriggerFocus } from "@/lib/datasets/popover-focus";

const source = readFileSync(new URL("../../src/components/datasets/dataset-row-actions.tsx", import.meta.url), "utf8");
const base = { activeIsBody: false, activeInsidePanel: false, triggerConnected: true, triggerDisabled: false };

test("focus returns to the trigger when a native dismissal left it on <body> or inside the hidden panel", () => {
  assert.equal(shouldRestoreTriggerFocus({ ...base, activeIsBody: true }), true);
  assert.equal(shouldRestoreTriggerFocus({ ...base, activeInsidePanel: true }), true);
});

test("focus the user moved elsewhere is never taken back", () => {
  assert.equal(shouldRestoreTriggerFocus(base), false);
});

test("an unmounted or disabled trigger is never focused", () => {
  assert.equal(shouldRestoreTriggerFocus({ ...base, activeIsBody: true, triggerConnected: false }), false);
  assert.equal(shouldRestoreTriggerFocus({ ...base, activeIsBody: true, triggerDisabled: true }), false);
});

test("contract: the popover stays native (auto popover, no key handler that could trigger row navigation) and every close path restores focus", () => {
  assert.match(source, /popover="auto"/);
  assert.match(source, /popoverTarget=\{panelId\}/);
  assert.match(source, /onToggle=\{event => \{ const isOpen = event\.newState === "open"; setOpen\(isOpen\); if \(!isOpen\) restoreTriggerFocusAfterDismissal\(\); \}\}/);
  assert.ok(!/onKeyDown/.test(source), "Escape is handled natively; no custom key handler");
  assert.match(source, /function closePanel\(\) \{[\s\S]*?trigger\.current\?\.focus\(/, "the explicit Close button still focuses the trigger");
  assert.match(source, /aria-haspopup="dialog"[\s\S]*aria-controls=\{panelId\}[\s\S]*aria-expanded=\{open\}/);
});
