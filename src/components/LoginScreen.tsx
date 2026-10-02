import { useEffect, useRef, useState } from "react";
import { BookOpen, ArrowRight, Loader2 } from "lucide-react";
import { HttpError } from "@/lib/http";
import { useAuthLogin, useAuthSetup } from "@/lib/user";

interface LoginScreenProps {
  needsSetup: boolean;
}

export function LoginScreen({ needsSetup }: LoginScreenProps) {
  const login = useAuthLogin();
  const setup = useAuthSetup();
  const mutation = needsSetup ? setup : login;
  const pending = mutation.isPending;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const usernameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameInputRef.current?.focus();
  }, []);
  const passwordsMatch = !needsSetup || password === confirm;
  const canSubmit =
    username.trim().length > 0 &&
    password.length >= (needsSetup ? 8 : 1) &&
    passwordsMatch &&
    !pending;
  const clearError = () => {
    if (mutation.isError) mutation.reset();
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      { username: username.trim(), password },
      {
        onSuccess: () => {
          setPassword("");
          setConfirm("");
        },
      },
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-parchment paper-texture px-5 py-10 sm:px-8">
      <main
        id="main-content"
        className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-ink bg-surface shadow-xl md:grid-cols-2"
      >
        <div className="relative hidden flex-col justify-between bg-accent p-10 text-white md:flex">
          <div className="flex items-center gap-3">
            <BookOpen className="h-7 w-7" strokeWidth={1.5} aria-hidden="true" />
            <span className="text-xl font-semibold tracking-tight">Caliber</span>
          </div>
          <div className="my-16">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
              Your personal library
            </p>
            <h2 className="mt-4 text-4xl font-medium leading-tight tracking-tight">
              A little space for
              <br />a world of stories.
            </h2>
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-white/75">
              All your books, a place on your shelf, and a bookmark waiting where you left it.
            </p>
          </div>
          <div className="flex items-end gap-2 border-b border-white/30 pb-0" aria-hidden="true">
            {[
              { id: "stories", height: "h-20" },
              { id: "novels", height: "h-24" },
              { id: "essays", height: "h-16" },
              { id: "poems", height: "h-28" },
              { id: "memoirs", height: "h-20" },
              { id: "travels", height: "h-24" },
              { id: "classics", height: "h-16" },
            ].map((book) => (
              <span
                key={book.id}
                className={`${book.height} w-8 rounded-t border border-white/20 bg-white/10`}
              />
            ))}
          </div>
        </div>
        <div className="p-7 sm:p-10 md:py-14">
          <div className="mb-9 flex items-center gap-2 text-accent md:hidden">
            <BookOpen className="h-6 w-6" strokeWidth={1.5} aria-hidden="true" />
            <span className="text-lg font-semibold">Caliber</span>
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
            {needsSetup ? "A new chapter" : "Welcome back"}
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
            {needsSetup ? "Your library starts here" : "Come in. Find your next read."}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-tertiary">
            {needsSetup
              ? "Create the first account to make this library your own."
              : "Sign in to pick up where you left off."}
          </p>
          <form onSubmit={submit} aria-busy={pending} className="mt-8 flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="login-username" className="text-sm font-medium text-ink">
                Username
              </label>
              <input
                id="login-username"
                name="username"
                type="text"
                ref={usernameInputRef}
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  clearError();
                }}
                placeholder="Your username"
                maxLength={40}
                required
                disabled={pending}
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                className="input min-h-11 px-3.5 py-2.5 text-base"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="login-password" className="text-sm font-medium text-ink">
                Password
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearError();
                }}
                placeholder={needsSetup ? "At least 8 characters" : "Your password"}
                minLength={needsSetup ? 8 : undefined}
                maxLength={512}
                required
                disabled={pending}
                autoComplete={needsSetup ? "new-password" : "current-password"}
                aria-describedby={needsSetup ? "password-hint" : undefined}
                className="input min-h-11 px-3.5 py-2.5 text-base"
              />
              {needsSetup && (
                <p id="password-hint" className="text-xs text-ink-tertiary">
                  Use at least 8 characters.
                </p>
              )}
            </div>
            {needsSetup && (
              <div className="flex flex-col gap-2">
                <label htmlFor="login-confirm" className="text-sm font-medium text-ink">
                  Confirm password
                </label>
                <input
                  id="login-confirm"
                  name="confirm"
                  type="password"
                  value={confirm}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    clearError();
                  }}
                  placeholder="Repeat your password"
                  maxLength={512}
                  required
                  disabled={pending}
                  autoComplete="new-password"
                  aria-invalid={confirm.length > 0 && !passwordsMatch}
                  aria-describedby={
                    confirm.length > 0 && !passwordsMatch ? "password-mismatch" : undefined
                  }
                  className="input min-h-11 px-3.5 py-2.5 text-base"
                />
              </div>
            )}
            {confirm.length > 0 && !passwordsMatch && (
              <p id="password-mismatch" className="text-xs text-red-600" role="alert">
                Passwords do not match.
              </p>
            )}
            {mutation.error && (
              <p className="text-sm text-red-600" role="alert">
                {mutation.error instanceof HttpError
                  ? mutation.error.message
                  : "Could not connect. Please try again."}
              </p>
            )}
            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-1 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              )}
              {pending
                ? needsSetup
                  ? "Creating account…"
                  : "Signing in…"
                : needsSetup
                  ? "Create account"
                  : "Sign in"}
            </button>
            {!needsSetup && (
              <p className="text-center text-xs leading-relaxed text-ink-tertiary">
                Your account also works with OPDS readers.
              </p>
            )}
          </form>
        </div>
      </main>
    </div>
  );
}
