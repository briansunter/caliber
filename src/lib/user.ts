import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, HttpError } from "./http";
import {
  clearPendingProgressOutbox,
  scheduleProgressOutboxRetry,
  setOutboxPrincipal,
} from "./reading-progress";

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
const PRINCIPAL_QUERY_KEYS = new Set([
  "books",
  "stats",
  "tags",
  "formats",
  "reading-list",
  "book",
  "auth-config",
  "library-config",
]);
const principalQueryFilter = {
  predicate: (query: { queryKey: readonly unknown[] }) =>
    PRINCIPAL_QUERY_KEYS.has(String(query.queryKey[0])),
};

type SessionQueryClient = ReturnType<typeof useQueryClient>;
interface PrincipalReconciliation {
  userId: number | null;
  ready: Promise<boolean>;
}
const reconciliations = new WeakMap<SessionQueryClient, PrincipalReconciliation>();

// /me can discover a changed session after another tab signs in or a session
// expires. Reconcile once per identity before its route mounts; unchanged
// responses and multiple observers share this work without clearing caches.
export function reconcileSessionPrincipal(
  qc: SessionQueryClient,
  userId: number | null,
): Promise<boolean> {
  const previous = reconciliations.get(qc);
  if (previous?.userId === userId) return previous.ready;
  const reconciliation: PrincipalReconciliation = { userId, ready: Promise.resolve(false) };
  reconciliations.set(qc, reconciliation);
  clearPendingProgressOutbox();
  setOutboxPrincipal(userId);
  reconciliation.ready = (async () => {
    await qc.cancelQueries(principalQueryFilter);
    if (reconciliations.get(qc) !== reconciliation) return false;
    qc.removeQueries(principalQueryFilter);
    if (userId !== null) scheduleProgressOutboxRetry(500);
    return true;
  })();
  return reconciliation.ready;
}

export function useCurrentUser() {
  const query = useQuery({
    queryKey: USER_KEY,
    queryFn: ({ signal }) => fetchJson<MeResponse>("/api/user/me", { signal }),
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: true,
  });
  const isAuthExpired = query.error instanceof HttpError && query.error.status === 401;
  return {
    user: isAuthExpired ? null : (query.data?.user ?? null),
    authRequired: isAuthExpired || query.data?.authRequired === true,
    needsSetup: query.data?.needsSetup === true,
    isLoading: query.isLoading,
    isAuthExpired,
    hasSessionState: query.data !== undefined,
    error: query.error,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}

export interface Credentials {
  username: string;
  password: string;
}

async function switchPrincipal(
  qc: ReturnType<typeof useQueryClient>,
  user: PublicUser | null,
  authRequired: boolean,
) {
  const principalId = user?.id ?? null;
  const reconciliation = reconcileSessionPrincipal(qc, principalId);
  // An older /me response must not overwrite the session established by login.
  await qc.cancelQueries({ queryKey: USER_KEY });
  if (!(await reconciliation) || reconciliations.get(qc)?.userId !== principalId) return;
  if (user) {
    qc.setQueryData(USER_KEY, { user, authRequired, needsSetup: false });
  } else {
    qc.setQueryData(USER_KEY, { user: null, authRequired, needsSetup: false });
  }
}

function applySession(qc: ReturnType<typeof useQueryClient>, user: PublicUser) {
  return switchPrincipal(qc, user, true);
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
      return switchPrincipal(qc, data.user, false);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchJson<{ ok: boolean }>("/api/user/logout", { method: "POST" }),
    onSuccess: async () => {
      // Clear the previous principal's outbox and principal-scoped caches.
      const authRequired = qc.getQueryData<MeResponse>(USER_KEY)?.authRequired ?? true;
      await switchPrincipal(qc, null, authRequired);
      // Re-fetch rather than assume: with auth enabled the login screen
      // should return; without it the app stays open with no profile.
      await qc.invalidateQueries({ queryKey: USER_KEY });
    },
  });
}
