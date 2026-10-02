import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { useLibraryConfig, type LibraryConfigStatus } from "@/hooks/useBooksInfinite";
import { fetchJson } from "@/lib/http";
import { useCurrentUser } from "@/lib/user";
import { clearPendingProgressOutbox, setLibraryScopeId } from "@/lib/reading-progress";

interface LibraryConfigPanelProps {
  onboarding?: boolean;
}

export function LibraryConfigPanel({ onboarding = false }: LibraryConfigPanelProps) {
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const { data: config, isLoading, error: configError, refetch } = useLibraryConfig();
  const [databasePath, setDatabasePath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config?.databasePath) setDatabasePath(config.databasePath);
  }, [config?.databasePath]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving || !databasePath.trim() || !config || config.environmentOverride) return;
    setIsSaving(true);
    setMessage(null);
    setError(null);
    // Drop pending saves before the server changes libraries so a timer cannot
    // write an old book's progress against the replacement library.
    clearPendingProgressOutbox();
    try {
      const body = await fetchJson<LibraryConfigStatus>("/api/config/library", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ databasePath: databasePath.trim() }),
      });
      clearPendingProgressOutbox();
      if (body.libraryId) {
        setLibraryScopeId(body.libraryId);
      }
      window.dispatchEvent(new CustomEvent("caliber:library-changed"));
      const libraryKeys = new Set(["books", "book", "stats", "tags", "formats"]);
      const libraryFilter = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          libraryKeys.has(String(query.queryKey[0])),
      };
      await queryClient.cancelQueries({ queryKey: ["library-config"] });
      await queryClient.cancelQueries(libraryFilter);
      queryClient.removeQueries(libraryFilter);
      queryClient.setQueriesData<LibraryConfigStatus>({ queryKey: ["library-config"] }, body);
      queryClient.setQueryData(["library-config", user?.id ?? "anon"], body);
      // The shelf uses a shared key, so clear its observer data and refetch it.
      await queryClient.resetQueries({ queryKey: ["reading-list"] });
      setDatabasePath(body.databasePath);
      setMessage(
        onboarding
          ? "Library connected. Your books are ready to browse."
          : "Your new library is ready to browse.",
      );
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not change library");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section
      className={`rounded-xl border border-ink bg-surface p-5 shadow-sm sm:p-7 ${onboarding ? "" : "mb-4"}`}
    >
      <div className="mb-5 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <FolderOpen className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-ink">
            {onboarding ? "Give your books a home" : "Calibre library"}
          </h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-tertiary">
            {onboarding
              ? "Enter the folder containing your Calibre library, or the full path to its metadata.db file."
              : "Choose the library you want to browse. Your original Calibre library stays read-only."}
          </p>
        </div>
      </div>
      <form onSubmit={save} aria-busy={isSaving || isLoading} className="space-y-4">
        <div>
          <label htmlFor="calibre-database-path" className="text-sm font-medium text-ink">
            Database path
          </label>
          <input
            id="calibre-database-path"
            name="databasePath"
            type="text"
            value={databasePath}
            onChange={(event) => {
              setDatabasePath(event.target.value);
              setError(null);
              setMessage(null);
            }}
            placeholder={config?.defaultDatabasePath || "~/Calibre Library/metadata.db"}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={isLoading || isSaving || !config || config.environmentOverride}
            className="input mt-2 min-h-11 px-3.5 py-2.5 font-mono text-sm"
          />
          <p className="mt-2 break-all text-xs text-ink-tertiary">
            Default:{" "}
            <span className="font-mono">
              {config?.defaultDatabasePath || "~/Calibre Library/metadata.db"}
            </span>
          </p>
        </div>
        {config?.environmentOverride && (
          <output className="block text-xs text-amber-700">
            The path is controlled by an environment variable. Update that variable to change
            libraries.
          </output>
        )}
        {message && (
          <output className="block text-sm text-accent" aria-live="polite">
            {message}
          </output>
        )}
        {(error || configError) && (
          <div className="text-sm text-red-700" role="alert">
            <p>
              {error ||
                (configError instanceof Error
                  ? configError.message
                  : "Could not read library configuration.")}
            </p>
            {configError && (
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-1 min-h-10 font-semibold underline"
              >
                Try again
              </button>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={
            isLoading || isSaving || !databasePath.trim() || !config || config.environmentOverride
          }
          className="btn-primary inline-flex min-h-11 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {isSaving ? "Connecting library…" : onboarding ? "Connect library" : "Use this library"}
        </button>
      </form>
    </section>
  );
}
