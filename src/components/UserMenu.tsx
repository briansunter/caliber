import { useEffect, useRef, useState } from "react";
import { User as UserIcon, LogOut, Check } from "lucide-react";
import { useCurrentUser, useLogin, useLogout } from "@/lib/user";

export function UserMenu() {
  const { user, isLoading } = useCurrentUser();
  const login = useLogin();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open && !user) inputRef.current?.focus();
  }, [open, user]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || login.isPending) return;
    login.mutate(trimmed, {
      onSuccess: () => {
        setName("");
        setOpen(false);
      },
    });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-ink bg-surface px-2.5 py-1.5 text-sm font-medium text-ink hover:bg-parchment-dark transition-colors"
        aria-label={user ? `Signed in as ${user.username}` : "Sign in"}
        title={user ? `Signed in as ${user.username}` : "Sign in"}
      >
        <UserIcon className="h-4 w-4" strokeWidth={1.5} />
        <span className="hidden sm:inline max-w-[120px] truncate">
          {isLoading ? "…" : user ? user.username : "Sign in"}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-ink bg-surface p-3 shadow-lg">
          {user ? (
            <div className="flex flex-col gap-2">
              <div className="px-1 pb-1">
                <p className="text-xs text-ink-tertiary">Signed in as</p>
                <p className="truncate text-sm font-semibold text-ink">{user.username}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  logout.mutate();
                  setOpen(false);
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-parchment-dark transition-colors"
              >
                <LogOut className="h-4 w-4" strokeWidth={1.5} />
                Sign out
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-2">
              <label htmlFor="username-input" className="px-1 text-xs text-ink-tertiary">
                Enter a username to save your reading progress
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id="username-input"
                  name="username"
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="username"
                  maxLength={40}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="username"
                  className="min-w-0 flex-1 rounded-md border border-ink bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  type="submit"
                  disabled={!name.trim() || login.isPending}
                  className="flex items-center justify-center rounded-md bg-ink px-2.5 py-1.5 text-white disabled:opacity-40 hover:bg-ink/90 transition-colors"
                  aria-label="Save username"
                >
                  <Check className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              {login.isError && (
                <p className="px-1 text-xs text-red-600" role="alert" aria-live="polite">
                  Couldn’t sign in. Try again.
                </p>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
