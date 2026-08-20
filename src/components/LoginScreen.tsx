import { useEffect, useRef, useState } from "react";
import { BookOpen, LogIn } from "lucide-react";
import { HttpError } from "@/lib/http";
import { useAuthLogin, useAuthSetup } from "@/lib/user";

interface LoginScreenProps {
  needsSetup: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpError && error.message) return error.message;
  return "Something went wrong. Try again.";
}

export function LoginScreen({ needsSetup }: LoginScreenProps) {
  const login = useAuthLogin();
  const setup = useAuthSetup();
  const pending = login.isPending || setup.isPending;
  const error = login.error ?? setup.error;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const usernameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameInputRef.current?.focus();
  }, []);

  const passwordsMatch = !needsSetup || password === confirm;
  const canSubmit =
    username.trim().length > 0 && password.length > 0 && passwordsMatch && !pending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = username.trim();
    if (!canSubmit || !passwordsMatch) return;
    const mutation = needsSetup ? setup : login;
    mutation.mutate(
      { username: trimmed, password },
      {
        onSuccess: () => {
          setPassword("");
          setConfirm("");
        },
      },
    );
  };

  return (
    <div className="min-h-screen bg-parchment paper-texture flex items-center justify-center px-4">
      <main id="main-content" className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 bg-ink rounded-xl flex items-center justify-center shadow-sm">
            <BookOpen className="h-6 w-6 text-white" strokeWidth={1.5} />
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-ink tracking-tight">Caliber</h1>
          <p className="mt-1 text-sm text-ink-tertiary">
            {needsSetup ? "Create the first account for this library" : "Sign in to your library"}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="bg-surface border border-ink rounded-lg shadow-sm p-5 flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-username" className="text-sm font-medium text-ink">
              Username
            </label>
            <input
              id="login-username"
              name="username"
              type="text"
              ref={usernameInputRef}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              maxLength={40}
              required
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              className="rounded-md border border-ink bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-password" className="text-sm font-medium text-ink">
              Password
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={needsSetup ? "At least 8 characters" : "password"}
              required
              autoComplete={needsSetup ? "new-password" : "current-password"}
              className="rounded-md border border-ink bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          {needsSetup && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="login-confirm" className="text-sm font-medium text-ink">
                Confirm password
              </label>
              <input
                id="login-confirm"
                name="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="repeat password"
                required
                autoComplete="new-password"
                className="rounded-md border border-ink bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          )}

          {confirm.length > 0 && !passwordsMatch && (
            <p className="text-xs text-red-600" role="alert">
              Passwords do not match.
            </p>
          )}
          {error && (
            <p className="text-xs text-red-600" role="alert" aria-live="polite">
              {errorMessage(error)}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-40 transition-colors"
          >
            <LogIn className="h-4 w-4" strokeWidth={1.5} />
            {needsSetup ? "Create account" : "Sign in"}
          </button>

          {!needsSetup && (
            <p className="text-xs text-ink-tertiary text-center">
              OPDS readers can sign in with the same username and password.
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
