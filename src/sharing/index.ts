// Sharing (R-008): what a person shares of their own brain with another member of a circle, read-only and by
// chosen category. It joins the circle store (membership and grants), the user controller (the session) and the
// graph store's reads. `src/circles/` still cannot read a graph; only this component joins grants to graphs.

export { createSharing, DEFAULT_GRANT_LIMITS, DEFAULT_PAGE, MAX_PAGE } from './sharing.js';
export type { GrantView, SharedBrainView, SharedCategoryEntry, SharedCategoryItems, SharedItemDetail, SharedItemView, Page, PageRequest, SharedCategoryView, Sharing, SharingInit, SharingLimits } from './sharing.js';
