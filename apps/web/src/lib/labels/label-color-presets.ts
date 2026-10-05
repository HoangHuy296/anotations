/**
 * The 24 uppercase #RRGGBB presets of the label color picker, extracted unchanged from components/labels/label-form.tsx so the
 * picker and the deterministic confirmed-class colors share one palette. Order is significant (it defines the hash slots).
 */
export const LABEL_COLOR_PRESETS = [
  "#0EA5E9", "#2563EB", "#4F46E5", "#7C3AED", "#9333EA", "#C026D3",
  "#DB2777", "#E11D48", "#EA580C", "#F97316", "#CA8A04", "#EAB308",
  "#65A30D", "#16A34A", "#059669", "#0F766E", "#0891B2", "#475569",
  "#334155", "#78350F", "#BE123C", "#A21CAF", "#1D4ED8", "#047857",
] as const;
