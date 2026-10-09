/**
 * Whether keyboard focus should move back to a popover's trigger after the popover closed.
 *
 * A native dismissal (Escape, or a light dismiss) hides the popover without any script running, so focus falls to <body>. Focus goes back to the trigger only
 * when it would otherwise be lost: it is on <body> or inside the now-hidden panel, and the trigger is still mounted and enabled. Focus the user moved elsewhere
 * (for example by clicking another control) is never taken back.
 */
export function shouldRestoreTriggerFocus(input: {
  activeIsBody: boolean;
  activeInsidePanel: boolean;
  triggerConnected: boolean;
  triggerDisabled: boolean;
}): boolean {
  if (!input.triggerConnected || input.triggerDisabled) return false;
  return input.activeIsBody || input.activeInsidePanel;
}
