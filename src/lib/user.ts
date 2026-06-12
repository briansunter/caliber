import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "./http";

export interface PublicUser {
  id: number;
  username: string;
}

const USER_KEY = ["user", "me"] as const;

export function useCurrentUser() {
  const query = useQuery({
    queryKey: USER_KEY,
    queryFn: () => fetchJson<{ user: PublicUser | null }>("/api/user/me"),
    staleTime: 1000 * 60 * 10,
  });
  return {
    user: query.data?.user ?? null,
    isLoading: query.isLoading,
  };
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
      qc.setQueryData(USER_KEY, { user: data.user });
      qc.invalidateQueries({ queryKey: ["reading-list"] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchJson<{ ok: boolean }>("/api/user/logout", { method: "POST" }),
    onSuccess: () => {
      qc.setQueryData(USER_KEY, { user: null });
      qc.invalidateQueries({ queryKey: ["reading-list"] });
    },
  });
}
