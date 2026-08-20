import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "./http";
import type { PublicUser } from "./user";

export interface AuthAccount {
  id: number;
  username: string;
  hasPassword: boolean;
}

export interface AuthConfigStatus {
  authEnabled: boolean;
  hasAccounts: boolean;
  canManage: boolean;
  envControlled: boolean;
  users?: AuthAccount[];
}

const AUTH_CONFIG_KEY = ["auth-config"] as const;

export function useAuthConfig() {
  const query = useQuery({
    queryKey: AUTH_CONFIG_KEY,
    queryFn: () => fetchJson<AuthConfigStatus>("/api/config/auth"),
    staleTime: 30 * 1000,
  });
  return {
    config: query.data ?? null,
    isLoading: query.isLoading,
  };
}

export interface EnableAuthInput {
  enabled: boolean;
  username?: string;
  password?: string;
}

// Toggling can change the signed-in state (enabling with a new first account
// sets the session cookie; disabling signs nobody out but removes the gate),
// so callers invalidate ["user", "me"] too.
export function useSetAuthEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EnableAuthInput) =>
      fetchJson<{ authEnabled: boolean; changed: boolean; user?: PublicUser }>(
        "/api/config/auth",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY });
      qc.invalidateQueries({ queryKey: ["user", "me"] });
    },
  });
}

export function useAddAuthUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      fetchJson<{ user: PublicUser }>("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY }),
  });
}

export function useSetAuthUserPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      fetchJson<{ user: PublicUser }>(
        `/api/auth/users/${encodeURIComponent(input.username)}/password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: input.password }),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY }),
  });
}

export function useRemoveAuthUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      fetchJson<{ removed: string }>(
        `/api/auth/users/${encodeURIComponent(username)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AUTH_CONFIG_KEY });
      qc.invalidateQueries({ queryKey: ["user", "me"] });
    },
  });
}
