import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { LibraryConfigStatus } from "@/hooks/useBooksInfinite";

interface LibraryConfigPanelProps {
  onboarding?: boolean;
}

export function LibraryConfigPanel({ onboarding = false }: LibraryConfigPanelProps) {
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<LibraryConfigStatus | null>(null);
  const [databasePath, setDatabasePath] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/library")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not read library configuration");
        return (await response.json()) as LibraryConfigStatus;
      })
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setDatabasePath(value.databasePath);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not read configuration");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/config/library", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ databasePath: databasePath.trim() }),
      });
      const body = (await response.json()) as LibraryConfigStatus & { error?: string; applied?: boolean };
      if (!response.ok) throw new Error(body.error || "Could not change library");
      setDatabasePath(body.databasePath);
      setConfig(body);
      queryClient.setQueryData(["library-config"], body);
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      queryClient.removeQueries({ queryKey: ["books"] });
      setMessage(onboarding ? "Library connected. Your books are ready to browse." : "Library changed and ready. Caliber will keep checking it for updates.");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not change library");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className={`bg-surface border border-ink rounded-lg shadow-sm p-4 sm:p-6 ${onboarding ? "" : "mb-4"}`}>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-ink">{onboarding ? "Choose your Calibre library" : "Calibre library"}</h2>
        <p className="text-xs text-ink-tertiary mt-1 max-w-xl">
          {onboarding
            ? "Select the metadata.db file from your Calibre library, or enter its folder. You can change this later in Settings."
            : "Point Caliber at any Calibre metadata.db. The database is copied into the Caliber cache for search indexes; your Calibre library stays read-only."}
        </p>
      </div>
      <form onSubmit={save} className="space-y-3">
        <div>
          <label htmlFor="calibre-database-path" className="text-sm font-medium text-ink">
            Database path
          </label>
          <input
            id="calibre-database-path"
            name="databasePath"
            type="text"
            value={databasePath}
            onChange={(event) => setDatabasePath(event.target.value)}
            placeholder={config?.defaultDatabasePath || "~/Calibre Library/metadata.db"}
            autoComplete="off"
            spellCheck={false}
            disabled={isLoading || isSaving || config?.environmentOverride === true}
            className="input mt-1"
          />
          <p className="text-xs text-ink-tertiary mt-1">
            Default: <span className="font-mono">{config?.defaultDatabasePath || "~/Calibre Library/metadata.db"}</span>
          </p>
        </div>
        {config?.environmentOverride && (
          <output className="block text-xs text-amber-700">
            The path is controlled by an environment variable. Update that variable to change libraries.
          </output>
        )}
        {message && <output className="block text-xs text-emerald-700" aria-live="polite">{message}</output>}
        {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
        <button
          type="submit"
          disabled={isLoading || isSaving || !databasePath.trim() || config?.environmentOverride === true}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "Checking database…" : onboarding ? "Connect library" : "Use this library"}
        </button>
      </form>
    </section>
  );
}
