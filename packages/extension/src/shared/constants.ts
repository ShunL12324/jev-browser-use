// Refs are stored as Symbol-keyed JS expandos on the elements they tag —
// see content-scripts/refs.ts. There is intentionally NO `data-*` ref
// attribute, since attributes are visible to page JS via querySelector
// and MutationObserver.

/** Name of the keepalive port the side panel opens against the SW. */
export const KEEPALIVE_PORT = 'quarry-keepalive'
