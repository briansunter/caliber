import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { BookOpen, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { LoginScreen } from "@/components/LoginScreen";
import { queryClient } from "@/lib/query-client";
import { reconcileSessionPrincipal, useCurrentUser } from "@/lib/user";

function RootShell() {
  const qc = useQueryClient();
  const { user, authRequired, needsSetup, isLoading, error, hasSessionState, isFetching, refetch } =
    useCurrentUser();
  const principalId = user?.id ?? null;
  const [preparedPrincipal, setPreparedPrincipal] = useState<number | null | undefined>(undefined);

  useLayoutEffect(() => {
    if (isLoading || (error && !hasSessionState)) return;
    let cancelled = false;
    void reconcileSessionPrincipal(qc, principalId).then((ready) => {
      if (!cancelled && ready) setPreparedPrincipal(principalId);
    });
    return () => {
      cancelled = true;
    };
  }, [qc, principalId, isLoading, error, hasSessionState]);

  // A 401 anywhere (expired session) re-checks auth state so the login
  // screen comes back instead of leaving the user with failing requests.
  useEffect(() => {
    const onUnauthorized = () => {
      // /me can emit this event itself. Let that request settle into its 401
      // error instead of canceling it and starting another identical request.
      void qc.invalidateQueries({ queryKey: ["user", "me"] }, { cancelRefetch: false });
    };
    window.addEventListener("caliber:unauthorized", onUnauthorized);
    return () => window.removeEventListener("caliber:unauthorized", onUnauthorized);
  }, [qc]);

  if (isLoading || (preparedPrincipal !== principalId && !(error && !hasSessionState))) {
    return (
      <div
        className="min-h-screen bg-parchment paper-texture flex items-center justify-center"
        aria-busy="true"
      >
        <output className="flex flex-col items-center gap-3" aria-live="polite">
          <Loader2 className="h-8 w-8 animate-spin text-ink-muted" strokeWidth={1.5} />
          <p className="text-sm text-ink-tertiary">Loading your library</p>
        </output>
      </div>
    );
  }

  if (authRequired && !user) {
    return <LoginScreen needsSetup={needsSetup} />;
  }

  if (error && !hasSessionState) {
    return (
      <main
        id="main-content"
        className="min-h-screen bg-parchment flex items-center justify-center px-6"
      >
        <div className="max-w-sm rounded-2xl border border-ink bg-surface p-8 text-center shadow-sm">
          <BookOpen className="mx-auto h-9 w-9 text-accent" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="mt-5 text-xl font-semibold text-ink">Your library is unavailable</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-secondary" role="alert">
            Caliber could not connect to the server. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {isFetching ? "Connecting…" : "Try again"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Outlet key={user?.id ?? "anon"} />
    </div>
  );
}

export const Route = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <RootShell />
    </QueryClientProvider>
  ),
});
