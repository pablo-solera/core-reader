export const requestStatuses = ["queued", "running", "rate_limited", "paused", "cancelling", "cancelled", "completed", "failed"] as const;
export type RequestStatus = (typeof requestStatuses)[number];

export type StatusPolicy = {
  isActive(status: RequestStatus): boolean;
  isTerminal(status: RequestStatus): boolean;
  isResumable(status: RequestStatus): boolean;
};

export const defaultStatusPolicy: StatusPolicy = {
  isActive: status => status === "queued" || status === "running" || status === "rate_limited",
  isTerminal: status => status === "completed" || status === "failed" || status === "cancelled",
  isResumable: status => status === "failed" || status === "paused" || status === "rate_limited",
};
