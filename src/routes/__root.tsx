import { useEffect } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { useCurrentUser } from "@/lib/user";
import { LoginScreen } from "@/components/LoginScreen";

function RootShell() {
  const qc = useQueryClient();
  const { user, authRequired, needsSetup, isLoading } = useCurrentUser();

  // A 401 anywhere (expired session) re-checks auth state so the login
  // screen comes back instead of leaving the user with failing requests.
  useEffect(() => {
    const onUnauthorized = () => {
      qc.invalidateQueries({ queryKey: ["user", "me"] });
    };
    window.addEventListener("caliber:unauthorized", onUnauthorized);
    return () => window.removeEventListener("caliber:unauthorized", onUnauthorized);
  }, [qc]);

  if (isLoading) {
    return <div className="min-h-screen bg-parchment paper-texture" aria-busy="true" />;
  }

  if (authRequired && !user) {
    return <LoginScreen needsSetup={needsSetup} />;
  }

  return (
    <div className="min-h-screen bg-background">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Outlet />
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
