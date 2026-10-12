/**
 * "Active" assets: not soft-deleted and not archived. Every user-facing asset count (library cards, dashboard, overview) must use this one definition,
 * otherwise a deleted asset keeps being counted ("3 assets" after deleting one) while another screen already shows the right number.
 */
export const ACTIVE_ASSET_WHERE = { deletedAt: null, archivedAt: null } as const;
