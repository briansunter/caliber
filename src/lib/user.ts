import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "./http";

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
  };
}

export interface Credentials {
  username: string;
  password: string;
}

function applySession(qc: ReturnType<typeof useQueryClient>, user: PublicUser) {
  qc.setQueryData(USER_KEY, { user, authRequired: true, needsSetup: false });
  qc.invalidateQueries({ queryKey: ["reading-list"] });
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
      qc.setQueryData(USER_KEY, { user: data.user, authRequired: false, needsSetup: false });
      qc.invalidateQueries({ queryKey: ["reading-list"] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchJson<{ ok: boolean }>("/api/user/logout", { method: "POST" }),
    onSuccess: () => {
      // Re-fetch rather than assume: with auth enabled the login screen
      // should return; without it the app stays open with no profile.
      qc.invalidateQueries({ queryKey: USER_KEY });
      qc.invalidateQueries({ queryKey: ["reading-list"] });
    },
  });
}
