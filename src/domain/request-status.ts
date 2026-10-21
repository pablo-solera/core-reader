export const requestStatuses = ["queued", "running", "rate_limited", "paused", "cancelling", "cancelled", "completed", "failed"] as const;
export type RequestStatus = (typeof requestStatuses)[number];
