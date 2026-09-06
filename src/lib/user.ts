import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "./http";
import { clearPendingProgressOutbox, scheduleProgressOutboxRetry, setOutboxPrincipal } from "./reading-progress";

export interface PublicUser {
  id: number;
  username: string;
}

export interface MeResponse {
  user: PublicUser | null;
  authRequired: boolean;
  needsSetup: boolean;
}

const USER_KEY = ["user", "me"] as const;

export function useCurrentUser() {
  const query = useQuery({
    queryKey: USER_KEY,
    queryFn: () => fetchJson<MeResponse>("/api/user/me"),
    staleTime: 1000 * 60 * 10,
  });
  return {
    user: query.data?.user ?? null,
    authRequired: query.data?.authRequired === true,
    needsSetup: query.data?.needsSetup === true,
    isLoading: query.isLoading,
    isAuthExpired: query.error instanceof Error && /401/.test(query.error.message),
  };
}

export interface Credentials {
  username: string;
  password: string;
}

function switchPrincipal(qc: ReturnType<typeof useQueryClient>, user: PublicUser | null, authRequired: boolean) {
  // Never replay the previous principal's queued progress writes: cancel
  // retry timers, abort in-flight drains via the generation counter, and drop
  // in-memory pending saves. Other users' persisted outbox entries stay
  // queued (they only drain when their own principal+library matches).
  clearPendingProgressOutbox();
  setOutboxPrincipal(user ? user.id : null);
  // Drop principal-scoped caches; book/shelf keys are scoped by user id +
  // library id so stale cross-account data cannot be served.
  qc.removeQueries({ queryKey: ["books"] });
  qc.removeQueries({ queryKey: ["stats"] });
  qc.removeQueries({ queryKey: ["tags"] });
  qc.removeQueries({ queryKey: ["reading-list"] });
  qc.removeQueries({ queryKey: ["book"] });
  if (user) {
    qc.setQueryData(USER_KEY, { user, authRequired, needsSetup: false });
  } else {
    qc.setQueryData(USER_KEY, { user: null, authRequired, needsSetup: false });
  }
  qc.invalidateQueries({ queryKey: ["reading-list"] });
  // Drain only after the new principal is established; the gated drain sends
  // just entries matching this principal+library and keeps the rest queued.
  if (user) scheduleProgressOutboxRetry(500);
}

function applySession(qc: ReturnType<typeof useQueryClient>, user: PublicUser) {
  switchPrincipal(qc, user, true);
}

export function useAuthLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credentials: Credentials) =>
      fetchJson<{ user: PublicUser }>("/api/user/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      }),
    onSuccess: (data) => applySession(qc, data.user),
  });
}

export function useAuthSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credentials: Credentials) =>
      fetchJson<{ user: PublicUser }>("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      }),
    onSuccess: (data) => applySession(qc, data.user),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      fetchJson<{ user: PublicUser }>("/api/user/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      }),
    onSuccess: (data) => {
      switchPrincipal(qc, data.user, false);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchJson<{ ok: boolean }>("/api/user/logout", { method: "POST" }),
    onSuccess: () => {
      // Clear the previous principal's outbox and principal-scoped caches.
      switchPrincipal(qc, null, true);
      // Re-fetch rather than assume: with auth enabled the login screen
      // should return; without it the app stays open with no profile.
      qc.invalidateQueries({ queryKey: USER_KEY });
      qc.invalidateQueries({ queryKey: ["reading-list"] });
    },
  });
}
