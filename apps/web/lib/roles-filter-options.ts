/** Browser-safe filter options shared by the query parser and the filter controls. */
export const STATUS_VALUES = ["new", "active", "closed"] as const;
export type StatusFilter = (typeof STATUS_VALUES)[number];

export const SORT_KEYS = ["status", "fit", "company", "liveFor", "firstSeen", "title", "location", "decided"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
