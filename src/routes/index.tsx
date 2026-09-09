import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BookTableInfinite, TableHeader, SortHeader } from "@/components/BookTableInfinite";
import { BookGridInfinite } from "@/components/BookGridInfinite";
import { BookSearch } from "@/components/BookSearch";
import { LibraryConfigPanel } from "@/components/LibraryConfigPanel";
import { useState, useCallback, useMemo } from "react";
import { BookOpen, Users, Layers, Library, LayoutGrid, List, Settings, X } from "lucide-react";
import {
  useLibraryConfig,
  useLibraryStats,
  useTags,
  type SortConfig,
  type SortField,
} from "@/hooks/useBooksInfinite";
import { UserMenu } from "@/components/UserMenu";
import { TagFilter } from "@/components/TagFilter";
import { RecentlyRead } from "@/components/RecentlyRead";

type ViewMode = "list" | "grid";
type Density = "comfortable" | "compact";

const DENSITY_KEY = "caliber-density";

interface CanonicalState {
  view: ViewMode;
  sort: SortConfig;
  search: string;
  tags: number[];
}

const SORT_FIELDS: SortField[] = ["title", "author", "added", "rating"];

function toSearchParams(state: CanonicalState): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (state.search) params.q = state.search;
  params.view = state.view;
  params.sortBy = state.sort.field;
  params.sortOrder = state.sort.order;
  if (state.tags.length > 0) params.tag = state.tags.map(String);
  return params;
}

function loadDensity(): Density {
  try {
    const saved = sessionStorage.getItem(DENSITY_KEY);
    if (saved === "compact" || saved === "comfortable") return saved;
  } catch {}
  return "comfortable";
}

function saveDensity(density: Density) {
  try {
    // sessionStorage holds density prefs only; q/sort/view/tags live in the URL.
    sessionStorage.setItem(DENSITY_KEY, density);
  } catch {}
}

export const Route = createFileRoute("/")({
  // Canonical URL params for q/sort/view/tags so links are shareable.
  validateSearch: (search: Record<string, unknown>) => {
    const pick = (v: unknown): string | undefined =>
      typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
    const tags = search.tag;
    const tagList = Array.isArray(tags) ? tags : tags === undefined ? [] : [tags];
    return {
      q: pick(search.q) ?? "",
      view: pick(search.view) === "grid" ? "grid" : "list",
      sortBy: SORT_FIELDS.includes(pick(search.sortBy) as SortField)
        ? (pick(search.sortBy) as SortField)
        : "added",
      sortOrder: pick(search.sortOrder) === "asc" ? "asc" : "desc",
      tag: tagList.filter(
        (t): t is string => typeof t === "string" && /^\d+$/.test(t) && Number(t) > 0,
      ),
    };
  },
  component: IndexComponent,
});

function IndexComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const defaultView: ViewMode =
    typeof window !== "undefined" && window.innerWidth < 768 ? "grid" : "list";
  // Stable numeric tag ids for query keys.
  const tagNumbers = useMemo(() => {
    const list: unknown[] = Array.isArray(search.tag) ? search.tag : [];
    return list.filter((t): t is string => typeof t === "string" && /^\d+$/.test(t)).map(Number);
  }, [search.tag]);
  const uiState: CanonicalState = useMemo(
    () => ({
      view: search.view === "grid" ? "grid" : search.view === "list" ? "list" : defaultView,
      search: typeof search.q === "string" ? search.q : "",
      sort: {
        field: SORT_FIELDS.includes(search.sortBy as SortField)
          ? (search.sortBy as SortField)
          : "added",
        order: search.sortOrder === "asc" ? "asc" : "desc",
      },
      tags: tagNumbers,
    }),
    [search.q, search.view, search.sortBy, search.sortOrder, tagNumbers, defaultView],
  );
  const [density, setDensity] = useState<Density>(loadDensity);
  const searchQuery = uiState.search;
  const viewMode = uiState.view;
  const sortConfig = uiState.sort;
  // Selected tag chips render inside the sticky toolbar, growing its height.
  // The sticky table header offset must grow with it or the rows slide under.
  const hasSelectedTags = uiState.tags.length > 0;

  const updateCanonical = useCallback(
    (patch: Partial<CanonicalState>) => {
      const next: CanonicalState = {
        view: uiState.view,
        search: uiState.search,
        sort: uiState.sort,
        tags: uiState.tags,
        ...patch,
      };
      void navigate({ to: "/", search: toSearchParams(next) as never, replace: true });
    },
    [navigate, uiState],
  );

  const setSearchQuery = useCallback(
    (q: string) => updateCanonical({ search: q }),
    [updateCanonical],
  );
  const setViewMode = useCallback((v: ViewMode) => updateCanonical({ view: v }), [updateCanonical]);
  const setSortConfig = useCallback(
    (config: SortConfig) => updateCanonical({ sort: config }),
    [updateCanonical],
  );
  const setTags = useCallback((tags: number[]) => updateCanonical({ tags }), [updateCanonical]);
  const clearSearchAndFilters = useCallback(
    () => updateCanonical({ search: "", tags: [] }),
    [updateCanonical],
  );
  const toggleDensity = useCallback(() => {
    setDensity((prev) => {
      const next: Density = prev === "compact" ? "comfortable" : "compact";
      saveDensity(next);
      return next;
    });
  }, []);

  // Anchor-based scroll restore lives in BookGridInfinite/BookTableInfinite
  // (they fetch the required window, then scroll to the stored book anchor).

  const {
    data: libraryConfig,
    error: libraryConfigError,
    isLoading: libraryConfigLoading,
    refetch: refetchLibraryConfig,
  } = useLibraryConfig();
  const libraryReady = libraryConfig?.ready === true;
  const { data: stats, isLoading: statsLoading } = useLibraryStats(libraryReady);
  const { data: tags, isLoading: tagsLoading } = useTags(libraryReady);

  if (libraryConfigLoading || !libraryConfig) {
    return (
      <LibraryOnboarding
        isLoading
        error={libraryConfigError instanceof Error ? libraryConfigError.message : null}
        onRetry={() => refetchLibraryConfig()}
      />
    );
  }

  if (!libraryReady) {
    return (
      <LibraryOnboarding
        error={libraryConfigError instanceof Error ? libraryConfigError.message : null}
        onRetry={() => refetchLibraryConfig()}
      />
    );
  }

  return (
    <div
      className={`min-h-screen bg-parchment paper-texture${density === "compact" ? " density-compact" : ""}`}
    >
      {/* Main Content - Unified Scroll */}
      <main id="main-content" className="max-w-7xl mx-auto px-3 sm:px-6 pt-4 sm:pt-8 pb-10">
        {/* Welcome Section */}
        <div className="mb-3 sm:mb-6">
          <div className="flex items-center gap-2 sm:gap-3 mb-1 sm:mb-2">
            <div className="w-7 h-7 sm:w-9 sm:h-9 bg-ink rounded-lg flex items-center justify-center">
              <Library className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-white" strokeWidth={1.5} />
            </div>
            <h1 className="text-lg sm:text-2xl font-semibold text-ink tracking-tight">Caliber</h1>
            <div className="ml-auto flex items-center gap-1.5">
              <UserMenu />
              <Link
                to="/settings"
                className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-ink/5 transition-colors"
                aria-label="Settings"
                title="Settings"
              >
                <Settings className="h-5 w-5" strokeWidth={1.5} />
              </Link>
            </div>
          </div>
          <p className="hidden sm:block text-sm text-ink-tertiary max-w-2xl">
            Browse, search, and download from your personal digital library.
            {stats?.totalBooks && ` ${stats.totalBooks.toLocaleString()} volumes.`}
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-1.5 sm:gap-4 mb-3 sm:mb-6">
          <StatCard
            icon={<BookOpen className="h-4 w-4 text-accent" strokeWidth={2} />}
            value={statsLoading ? "—" : stats?.totalBooks.toLocaleString() || "0"}
            label="Books"
          />
          <StatCard
            icon={<Users className="h-4 w-4 text-accent" strokeWidth={2} />}
            value={statsLoading ? "—" : stats?.totalAuthors.toLocaleString() || "0"}
            label="Authors"
          />
          <StatCard
            icon={<Layers className="h-4 w-4 text-accent" strokeWidth={2} />}
            value={statsLoading ? "—" : stats?.totalSeries.toLocaleString() || "0"}
            label="Series"
          />
        </div>

        {/* Recently read shelf (only shown when signed in with history) */}
        <RecentlyRead />

        {/* Search Bar + View Toggle - Sticky at top */}
        <div className="sticky top-0 z-40 -mx-1 sm:-mx-2 px-1 sm:px-2 py-1.5 sm:py-2.5 bg-parchment border-y border-ink-strong shadow-sm">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex-1 min-w-0">
              <BookSearch onSearch={setSearchQuery} initialValue={searchQuery} />
            </div>
            <TagFilter
              tags={tags}
              selectedIds={uiState.tags}
              onChange={setTags}
              isLoading={tagsLoading}
            />
            <fieldset
              aria-label="View mode"
              className="m-0 p-0 flex-shrink-0 flex items-center border border-ink rounded-lg overflow-hidden"
            >
              <button
                type="button"
                onClick={() => setViewMode("list")}
                aria-pressed={viewMode === "list"}
                aria-label="List view"
                className={`p-2 transition-colors ${viewMode === "list" ? "bg-ink text-white" : "bg-surface text-ink-muted hover:text-ink"}`}
                title="List view"
              >
                <List className="h-4 w-4" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                aria-pressed={viewMode === "grid"}
                aria-label="Grid view"
                className={`p-2 transition-colors ${viewMode === "grid" ? "bg-ink text-white" : "bg-surface text-ink-muted hover:text-ink"}`}
                title="Grid view"
              >
                <LayoutGrid className="h-4 w-4" strokeWidth={1.5} />
              </button>
            </fieldset>
            <button
              type="button"
              onClick={toggleDensity}
              aria-pressed={density === "compact"}
              aria-label="Compact density"
              title="Toggle compact density"
              className={`p-2 transition-colors flex-shrink-0 border border-ink rounded-lg ${density === "compact" ? "bg-ink text-white" : "bg-surface text-ink-muted hover:text-ink"}`}
            >
              <span aria-hidden="true" className="block text-xs font-semibold leading-none px-0.5">
                ≡
              </span>
            </button>
          </div>
          {viewMode === "grid" && (
            <GridSortBar sortConfig={sortConfig} onSortChange={setSortConfig} />
          )}
          <SelectedTagChips
            selectedIds={uiState.tags}
            tags={tags}
            onRemove={(id) => setTags(uiState.tags.filter((t) => t !== id))}
            onClear={() => setTags([])}
          />
        </div>

        {viewMode === "list" && (
          <>
            {/* Table Header - Sticky below search; offset grows when the
                selected-tag chips add a row to the sticky toolbar. */}
            <div
              className={
                hasSelectedTags
                  ? "sticky top-[80px] sm:top-[90px] z-30 bg-parchment-dark"
                  : "sticky top-[46px] sm:top-[56px] z-30 bg-parchment-dark"
              }
            >
              <TableHeader sortConfig={sortConfig} onSortChange={setSortConfig} />
            </div>

            {/* Table Section */}
            <div className="bg-surface border-x border-b border-ink rounded-b-lg shadow-sm">
              <BookTableInfinite
                searchQuery={searchQuery}
                sortConfig={sortConfig}
                tagIds={uiState.tags}
                onClearFilters={clearSearchAndFilters}
              />
            </div>
          </>
        )}

        {viewMode === "grid" && (
          <div className="bg-surface border-x border-b border-ink rounded-b-lg shadow-sm pt-4">
            <BookGridInfinite
              searchQuery={searchQuery}
              sortConfig={sortConfig}
              tagIds={uiState.tags}
              onClearFilters={clearSearchAndFilters}
            />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-ink bg-surface">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="ornament text-ink-muted">
            <span className="text-sm">Caliber Library Manager</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LibraryOnboarding({
  isLoading = false,
  error,
  onRetry,
}: {
  isLoading?: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="min-h-screen bg-parchment paper-texture">
      <main id="main-content" className="max-w-xl mx-auto px-4 sm:px-6 pt-12 sm:pt-24 pb-16">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-ink rounded-xl flex items-center justify-center">
            <Library className="h-5 w-5 text-white" strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-ink-tertiary">Welcome to</p>
            <h1 className="text-2xl font-semibold text-ink tracking-tight">Caliber</h1>
          </div>
        </div>
        <div className="mb-5">
          <h2 className="text-3xl sm:text-4xl font-semibold text-ink tracking-tight">
            Connect your library
          </h2>
          <p className="text-sm text-ink-tertiary mt-2 max-w-lg">
            Caliber reads your Calibre library without changing it. Choose a database to get
            started, and Caliber will keep its local copy in sync while it is running.
          </p>
        </div>
        {isLoading && (
          <output className="block text-sm text-ink-tertiary mb-4" aria-live="polite">
            Checking the default Calibre location…
          </output>
        )}
        {error && (
          <div
            className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            role="alert"
          >
            {error}
            <button type="button" className="ml-2 underline" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        <LibraryConfigPanel onboarding />
        <p className="text-xs text-ink-tertiary mt-4">
          Looking for the default? Calibre usually stores it at{" "}
          <span className="font-mono">~/Calibre Library/metadata.db</span> on macOS and Linux, and
          in your user Documents folder on Windows.
        </p>
      </main>
    </div>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  value: string | number;
  label: string;
}

function GridSortBar({
  sortConfig,
  onSortChange,
}: {
  sortConfig: SortConfig;
  onSortChange: (config: SortConfig) => void;
}) {
  const handleSort = useCallback(
    (field: SortField) => {
      if (sortConfig.field === field) {
        onSortChange({ field, order: sortConfig.order === "asc" ? "desc" : "asc" });
      } else {
        onSortChange({ field, order: "asc" });
      }
    },
    [sortConfig, onSortChange],
  );

  return (
    <div className="flex items-center gap-3 mt-2 pt-2 border-t border-ink">
      <span className="text-xs text-ink-secondary uppercase tracking-wider font-semibold shrink-0">
        Sort
      </span>
      <div className="flex items-center gap-2 overflow-x-auto">
        <SortHeader label="Title" field="title" currentSort={sortConfig} onSort={handleSort} />
        <SortHeader label="Author" field="author" currentSort={sortConfig} onSort={handleSort} />
        <SortHeader label="Rating" field="rating" currentSort={sortConfig} onSort={handleSort} />
        <SortHeader label="Added" field="added" currentSort={sortConfig} onSort={handleSort} />
      </div>
    </div>
  );
}

// Removable chips for the currently selected tags. Rendered inside the
// sticky toolbar so active filters stay visible while scrolling. The URL
// (`?tag=`) remains the source of truth — chips only call onRemove/onClear.
function SelectedTagChips({
  selectedIds,
  tags,
  onRemove,
  onClear,
}: {
  selectedIds: number[];
  tags: { id: number; name: string }[] | undefined;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  if (selectedIds.length === 0) return null;
  const nameById = new Map((tags ?? []).map((t) => [t.id, t.name] as const));
  return (
    <ul
      className="mt-2 flex flex-wrap items-center gap-1.5 list-none m-0 p-0"
      aria-label="Selected tags"
    >
      {selectedIds.map((id) => {
        const name = nameById.get(id) ?? `Tag ${id}`;
        return (
          <li
            key={id}
            className="inline-flex items-center gap-1 rounded-full border border-ink bg-surface py-1 pl-2.5 pr-1.5 text-xs font-medium text-ink"
          >
            <span className="max-w-[160px] truncate">{name}</span>
            <button
              type="button"
              onClick={() => onRemove(id)}
              aria-label={`Remove ${name} filter`}
              className="flex h-5 w-5 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-parchment-dark hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear all selected tags"
          className="text-xs font-semibold text-accent hover:text-accent-hover transition-colors"
        >
          Clear all
        </button>
      </li>
    </ul>
  );
}

function StatCard({ icon, value, label }: StatCardProps) {
  return (
    <div className="stat-card flex items-center gap-2 sm:gap-3">
      <div className="hidden sm:flex w-10 h-10 bg-parchment-dark rounded-lg items-center justify-center border border-ink">
        {icon}
      </div>
      <div>
        <p className="stat-value">{value}</p>
        <p className="stat-label">{label}</p>
      </div>
    </div>
  );
}
