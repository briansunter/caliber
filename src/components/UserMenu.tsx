import { useCallback, useEffect, useId, useRef, useState } from "react";
import { User as UserIcon, LogOut, ArrowRight, Loader2, ChevronDown } from "lucide-react";
import { useCurrentUser, useLogin, useLogout } from "@/lib/user";
import { HttpError } from "@/lib/http";
import { useDialogFocusTrap } from "./ReaderChrome";

export function UserMenu() {
  const { user, isLoading } = useCurrentUser();
  const login = useLogin();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const usernameId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDialogFocusTrap(open, panelRef, close, triggerRef);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  useEffect(() => {
    if (open && !user) inputRef.current?.focus();
  }, [open, user]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || login.isPending) return;
    login.mutate(trimmed, {
      onSuccess: () => {
        setName("");
        close();
      },
    });
  };
  const mutationError = user ? logout.error : login.error;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        ref={triggerRef}
        disabled={isLoading}
        onClick={() => {
          login.reset();
          logout.reset();
          setOpen((value) => !value);
        }}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-ink bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-parchment-dark disabled:opacity-50"
        aria-label={user ? `Account for ${user.username}` : "Sign in to save your reading progress"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
          <UserIcon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="max-w-[140px] flex-1 truncate text-left">
          {isLoading ? "Loading…" : (user?.username ?? "Reader profile")}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={dialogId}
          ref={panelRef}
          role="dialog"
          aria-label="Reader profile"
          tabIndex={-1}
          className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-ink bg-surface p-4 shadow-xl"
        >
          {user ? (
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-xs text-ink-tertiary">Reading as</p>
                <p className="mt-1 truncate text-base font-semibold text-ink">{user.username}</p>
              </div>
              <button
                type="button"
                disabled={logout.isPending}
                onClick={() => logout.mutate(undefined, { onSuccess: close })}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-ink px-3 py-2 text-sm text-ink transition-colors hover:bg-parchment-dark disabled:opacity-50"
              >
                {logout.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <LogOut className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                )}
                {logout.isPending ? "Signing out…" : "Sign out"}
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3" aria-busy={login.isPending}>
              <div>
                <h2 className="text-sm font-semibold text-ink">Make yourself at home</h2>
                <p className="mt-1 text-xs leading-relaxed text-ink-tertiary">
                  Choose a username to keep your reading progress and personal bookshelf.
                </p>
              </div>
              <label htmlFor={usernameId} className="sr-only">
                Username
              </label>
              <input
                id={usernameId}
                name="username"
                ref={inputRef}
                type="text"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (login.isError) login.reset();
                }}
                placeholder="Your username"
                maxLength={40}
                required
                disabled={login.isPending}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="username"
                className="input min-h-11 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={!name.trim() || login.isPending}
                className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
              >
                {login.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                )}
                {login.isPending ? "Signing in…" : "Continue"}
              </button>
            </form>
          )}
          {mutationError && (
            <p className="mt-3 text-xs text-red-600" role="alert">
              {mutationError instanceof HttpError
                ? mutationError.message
                : user
                  ? "Could not sign out. Try again."
                  : "Could not sign in. Try again."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
