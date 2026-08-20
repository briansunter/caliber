import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { HttpError } from "@/lib/http";
import {
  useAddAuthUser,
  useAuthConfig,
  useRemoveAuthUser,
  useSetAuthEnabled,
  useSetAuthUserPassword,
} from "@/lib/auth-config";

const MIN_PASSWORD = 8;

function errorText(error: unknown): string {
  if (error instanceof HttpError && error.message) return error.message;
  return "Something went wrong. Try again.";
}

const inputClass =
  "rounded-md border border-ink bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent";
const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-ink px-3 py-1.5 text-sm text-ink-muted hover:text-ink hover:bg-ink/5 transition-colors disabled:opacity-40";

export function AuthConfigPanel() {
  const { config, isLoading } = useAuthConfig();
  const setEnabled = useSetAuthEnabled();
  const addUser = useAddAuthUser();
  const removeUser = useRemoveAuthUser();
  const setUserPassword = useSetAuthUserPassword();

  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminConfirm, setAdminConfirm] = useState("");

  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirm, setNewConfirm] = useState("");

  const [passwordUser, setPasswordUser] = useState<string | null>(null);
  const [rowPassword, setRowPassword] = useState("");
  const [rowConfirm, setRowConfirm] = useState("");

  const adminMatches = adminPassword === adminConfirm;
  const newMatches = newPassword === newConfirm;
  const rowMatches = rowPassword === rowConfirm;
  const busy =
    setEnabled.isPending || addUser.isPending || removeUser.isPending || setUserPassword.isPending;

  const enable = () => {
    setMessage(null);
    setActionError(null);
    const needsAccount = config != null && !config.hasAccounts;
    setEnabled.mutate(
      needsAccount
        ? { enabled: true, username: adminName.trim(), password: adminPassword }
        : { enabled: true },
      {
        onSuccess: (data) => {
          setMessage(
            data.user
              ? `Authentication on — signed in as ${data.user.username}.`
              : "Authentication on. Accounts must sign in from now on.",
          );
          setAdminName("");
          setAdminPassword("");
          setAdminConfirm("");
        },
        onError: (error) => setActionError(errorText(error)),
      },
    );
  };

  const disable = () => {
    if (!window.confirm("Disable authentication? The web app, API, and OPDS will be open to anyone who can reach this server.")) {
      return;
    }
    setMessage(null);
    setActionError(null);
    setEnabled.mutate(
      { enabled: false },
      {
        onSuccess: () => setMessage("Authentication off. Sign-in is no longer required."),
        onError: (error) => setActionError(errorText(error)),
      },
    );
  };

  const submitNewUser = (e: React.FormEvent) => {
    e.preventDefault();
    const username = newName.trim();
    if (!username || newPassword.length < MIN_PASSWORD || !newMatches || busy) return;
    setMessage(null);
    setActionError(null);
    addUser.mutate(
      { username, password: newPassword },
      {
        onSuccess: () => {
          setMessage(`Added ${username}.`);
          setNewName("");
          setNewPassword("");
          setNewConfirm("");
        },
        onError: (error) => setActionError(errorText(error)),
      },
    );
  };

  const submitRowPassword = (e: React.FormEvent, username: string) => {
    e.preventDefault();
    if (rowPassword.length < MIN_PASSWORD || !rowMatches || busy) return;
    setMessage(null);
    setActionError(null);
    setUserPassword.mutate(
      { username, password: rowPassword },
      {
        onSuccess: () => {
          setMessage(`Password updated for ${username}.`);
          setPasswordUser(null);
          setRowPassword("");
          setRowConfirm("");
        },
        onError: (error) => setActionError(errorText(error)),
      },
    );
  };

  const remove = (username: string) => {
    if (
      !window.confirm(
        `Remove ${username}? Their saved reading progress and sessions will be deleted.`,
      )
    ) {
      return;
    }
    setMessage(null);
    setActionError(null);
    removeUser.mutate(username, {
      onSuccess: () => setMessage(`Removed ${username}.`),
      onError: (error) => setActionError(errorText(error)),
    });
  };

  const canToggle = config?.canManage === true && config?.envControlled !== true;

  return (
    <section className="bg-surface border border-ink rounded-lg shadow-sm p-4 sm:p-6 mb-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-ink">Authentication</h2>
        <p className="text-xs text-ink-tertiary mt-1 max-w-xl">
          Optional sign-in for the web app, the JSON API, and OPDS readers. Each account keeps its
          own reading progress. OPDS apps sign in with the same username and password.
        </p>
      </div>

      {isLoading && <p className="text-xs text-ink-tertiary">Loading…</p>}

      {config && !config.canManage && (
        <output className="block text-xs text-amber-700">
          Authentication settings are available only while Caliber runs on localhost (or while
          signed in). Use CALIBER_AUTH_ENABLED to configure it for an exposed deployment.
        </output>
      )}

      {config?.envControlled && (
        <output className="block text-xs text-amber-700">
          The on/off state is controlled by the CALIBER_AUTH_ENABLED environment variable; use it
          to change it. Accounts can still be managed below.
        </output>
      )}

      {config && !config.authEnabled && (
        <div className="flex flex-col gap-3">
          {config.hasAccounts ? (
            <>
              <p className="text-sm text-ink">
                Authentication is <strong>off</strong>. Accounts exist and will be required to
                sign in once it is enabled.
              </p>
              <div>
                <button type="button" onClick={enable} disabled={!canToggle || busy} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
                  <span className="inline-flex items-center gap-1.5">
                    <KeyRound className="h-4 w-4" strokeWidth={1.5} />
                    Enable authentication
                  </span>
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  adminName.trim() &&
                  adminPassword.length >= MIN_PASSWORD &&
                  adminMatches &&
                  !busy
                ) {
                  enable();
                }
              }}
              className="flex flex-col gap-3 max-w-sm"
            >
              <p className="text-sm text-ink">
                Authentication is <strong>off</strong>. Enable it and create the first account —
                you will be signed in immediately.
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="auth-admin-username" className="text-sm font-medium text-ink">
                  Your username
                </label>
                <input
                  id="auth-admin-username"
                  type="text"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  maxLength={40}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="username"
                  disabled={!canToggle || busy}
                  className={inputClass}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="auth-admin-password" className="text-sm font-medium text-ink">
                  Password
                </label>
                <input
                  id="auth-admin-password"
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder={`At least ${MIN_PASSWORD} characters`}
                  autoComplete="new-password"
                  disabled={!canToggle || busy}
                  className={inputClass}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="auth-admin-confirm" className="text-sm font-medium text-ink">
                  Confirm password
                </label>
                <input
                  id="auth-admin-confirm"
                  type="password"
                  value={adminConfirm}
                  onChange={(e) => setAdminConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={!canToggle || busy}
                  className={inputClass}
                />
              </div>
              {adminConfirm.length > 0 && !adminMatches && (
                <p className="text-xs text-red-600" role="alert">
                  Passwords do not match.
                </p>
              )}
              <button
                type="submit"
                disabled={
                  !canToggle ||
                  busy ||
                  !adminName.trim() ||
                  adminPassword.length < MIN_PASSWORD ||
                  !adminMatches
                }
                className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="h-4 w-4" strokeWidth={1.5} />
                  Enable authentication
                </span>
              </button>
            </form>
          )}
        </div>
      )}

      {config?.authEnabled && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink">
            Authentication is <strong>on</strong>. The web app, API, and OPDS feeds require a
            signed-in account or Basic credentials.
          </p>
          <div>
            <button
              type="button"
              onClick={disable}
              disabled={!canToggle || busy}
              className={secondaryButtonClass}
            >
              Disable authentication
            </button>
          </div>
        </div>
      )}

      {config?.canManage && (
        <div className="mt-5 pt-4 border-t border-ink/10">
          <h3 className="text-sm font-semibold text-ink mb-2">Accounts</h3>
          {(config.users?.length ?? 0) === 0 && (
            <p className="text-xs text-ink-tertiary">
              No accounts yet.{" "}
              {config.authEnabled
                ? "The sign-in screen will offer to create the first one."
                : "Enable authentication to create the first one."}
            </p>
          )}
          {config.users && config.users.length > 0 && (
            <ul className="flex flex-col divide-y divide-ink/10">
              {config.users.map((user) => (
                <li key={user.id} className="py-2 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink font-medium">{user.username}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPasswordUser(passwordUser === user.username ? null : user.username);
                          setRowPassword("");
                          setRowConfirm("");
                        }}
                        className={secondaryButtonClass}
                        disabled={busy}
                      >
                        Change password
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(user.username)}
                        className={secondaryButtonClass}
                        disabled={busy}
                        aria-label={`Remove ${user.username}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Remove
                      </button>
                    </div>
                  </div>
                  {passwordUser === user.username && (
                    <form
                      onSubmit={(e) => submitRowPassword(e, user.username)}
                      className="flex flex-wrap items-end gap-2 max-w-md"
                    >
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={`auth-row-password-${user.id}`}
                          className="text-xs text-ink-tertiary"
                        >
                          New password
                        </label>
                        <input
                          id={`auth-row-password-${user.id}`}
                          type="password"
                          value={rowPassword}
                          onChange={(e) => setRowPassword(e.target.value)}
                          autoComplete="new-password"
                          className={inputClass}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={`auth-row-confirm-${user.id}`}
                          className="text-xs text-ink-tertiary"
                        >
                          Confirm
                        </label>
                        <input
                          id={`auth-row-confirm-${user.id}`}
                          type="password"
                          value={rowConfirm}
                          onChange={(e) => setRowConfirm(e.target.value)}
                          autoComplete="new-password"
                          className={inputClass}
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={rowPassword.length < MIN_PASSWORD || !rowMatches || busy}
                        className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Save
                      </button>
                      {rowConfirm.length > 0 && !rowMatches && (
                        <p className="text-xs text-red-600 w-full" role="alert">
                          Passwords do not match.
                        </p>
                      )}
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submitNewUser} className="mt-3 flex flex-wrap items-end gap-2 max-w-xl">
            <div className="flex flex-col gap-1">
              <label htmlFor="auth-new-username" className="text-xs text-ink-tertiary">
                Username
              </label>
              <input
                id="auth-new-username"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={40}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="auth-new-password" className="text-xs text-ink-tertiary">
                Password
              </label>
              <input
                id="auth-new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="auth-new-confirm" className="text-xs text-ink-tertiary">
                Confirm
              </label>
              <input
                id="auth-new-confirm"
                type="password"
                value={newConfirm}
                onChange={(e) => setNewConfirm(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              disabled={!newName.trim() || newPassword.length < MIN_PASSWORD || !newMatches || busy}
              className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add user
            </button>
            {newConfirm.length > 0 && !newMatches && (
              <p className="text-xs text-red-600 w-full" role="alert">
                Passwords do not match.
              </p>
            )}
          </form>
        </div>
      )}

      {message && (
        <output className="block text-xs text-emerald-700 mt-3" aria-live="polite">
          {message}
        </output>
      )}
      {actionError && (
        <p className="text-xs text-red-700 mt-3" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
