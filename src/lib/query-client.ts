import { QueryClient } from "@tanstack/query-core";
import { HttpError } from "./http";

// Validation/auth failures will not improve on a retry. Retry a transient
// network/server failure twice, while letting cancellation finish immediately.
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (
    error instanceof HttpError &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  ) {
    return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
    },
  },
});
