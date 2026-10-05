import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  FolderOpen,
  LayoutGrid,
  Library,
  List,
  Rows3,
  Settings,
  Tags,
  X,
} from "lucide-react";
import { BookTableInfinite, TableHeader } from "@/components/BookTableInfinite";
import { BookGridInfinite } from "@/components/BookGridInfinite";
import { BookSearch } from "@/components/BookSearch";
import { LibraryConfigPanel } from "@/components/LibraryConfigPanel";
import { UserMenu } from "@/components/UserMenu";
import { TagFilter } from "@/components/TagFilter";
import { FormatFilter } from "@/components/FormatFilter";
import { RecentlyRead } from "@/components/RecentlyRead";
import {
  useLibraryConfig,
  useLibraryStats,
  useTags,
  useFormats,
  type SortConfig,
  type SortField,
  type SortOrder,
} from "@/hooks/useBooksInfinite";
import { parseLibrarySearch, type LibrarySearch } from "@/lib/library-state";
import { useReadingList } from "@/lib/reading-progress";

type Density = "comfortable" | "compact";
const DENSITY_KEY = "caliber-density";
const SIDEBAR_TAGS_COLLAPSED_COUNT = 6;

function loadDensity(): Density {
  try {
    return sessionStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export const Route = createFileRoute("/")({
  validateSearch: parseLibrarySearch,
  component: IndexComponent,
});

function IndexComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [density, setDensity] = useState<Density>(loadDensity);
  const [showAllTags, setShowAllTags] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(120);
  const tagIds = useMemo(() => search.tag.map(Number), [search.tag]);
  const sortConfig = useMemo<SortConfig>(
    () => ({ field: search.sortBy, order: search.sortOrder }),
    [search.sortBy, search.sortOrder],
  );
  const {
    data: libraryConfig,
    error: libraryConfigError,
    isLoading: libraryConfigLoading,
    refetch: refetchLibraryConfig,
  } = useLibraryConfig();
  const libraryReady = libraryConfig?.ready === true;
  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
  } = useLibraryStats(libraryReady);
  const {
    data: tags,
    isLoading: tagsLoading,
    error: tagsError,
    refetch: refetchTags,
  } = useTags(libraryReady);
  const {
    data: formats,
    isLoading: formatsLoading,
    error: formatsError,
    refetch: refetchFormats,
  } = useFormats(libraryReady);
  const { data: readingList } = useReadingList();
  const recentCount = readingList?.items.length ?? 0;
  const hasFilters = Boolean(search.q || search.tag.length || search.format.length);
  const hasMoreSidebarTags = (tags?.length ?? 0) > SIDEBAR_TAGS_COLLAPSED_COUNT;
  const sidebarTags = showAllTags
    ? (tags ?? [])
    : [
        ...(tags ?? []).slice(0, SIDEBAR_TAGS_COLLAPSED_COUNT),
        ...(tags ?? []).slice(SIDEBAR_TAGS_COLLAPSED_COUNT).filter((tag) => tagIds.includes(tag.id)),
      ];

  // Functional URL updates preserve other controls changed in the same render.
  const updateSearch = useCallback(
    (patch: Partial<LibrarySearch>) => {
      void navigate({
        to: "/",
        search: (previous) => parseLibrarySearch({ ...previous, ...patch }),
        replace: true,
      });
    },
    [navigate],
  );
  const setSearchQuery = useCallback((q: string) => updateSearch({ q }), [updateSearch]);
  const setTags = useCallback(
    (ids: number[]) => updateSearch({ tag: ids.map(String) }),
    [updateSearch],
  );
  const setFormats = useCallback((format: string[]) => updateSearch({ format }), [updateSearch]);
  const setSortConfig = useCallback(
    (config: SortConfig) => updateSearch({ sortBy: config.field, sortOrder: config.order }),
    [updateSearch],
  );
  const clearSearchAndFilters = useCallback(
    () => updateSearch({ q: "", tag: [], format: [] }),
    [updateSearch],
  );
  const toggleDensity = useCallback(() => {
    setDensity((previous) => {
      const next = previous === "comfortable" ? "compact" : "comfortable";
      try {
        sessionStorage.setItem(DENSITY_KEY, next);
      } catch {}
      return next;
    });
  }, []);

  // Filter chips wrap on small screens. Measure actual chrome instead of guessing
  // a fixed offset, keeping the list header visible for every filter combination.
  useEffect(() => {
    if (!libraryReady) return;
    const element = toolbarRef.current;
    if (!element) return;
    const measure = () => setToolbarHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [libraryReady]);

  if (libraryConfigLoading || !libraryConfig || !libraryReady) {
    return (
      <LibraryOnboarding
        isLoading={libraryConfigLoading}
        error={libraryConfigError instanceof Error ? libraryConfigError.message : null}
        onRetry={() => void refetchLibraryConfig()}
      />
    );
  }

  const count = (value: number | undefined) =>
    statsLoading || statsError ? "—" : (value ?? 0).toLocaleString();
  const libraryName =
    libraryConfig.libraryPath.split(/[\\/]/).filter(Boolean).pop() || "Calibre Library";

  return (
    <div className={`library-shell${density === "compact" ? " density-compact" : ""}`}>
      <aside className="library-sidebar" aria-label="Library navigation">
        <a href="#main-content" className="library-brand" aria-label="Caliber home">
          <span className="brand-mark">
            <Library size={22} strokeWidth={1.6} />
          </span>
          <span>
            caliber<span className="brand-period">.</span>
          </span>
        </a>
        <p className="sidebar-eyebrow">Your reading space</p>
        <nav className="sidebar-nav" aria-label="Browse">
          <button
            type="button"
            onClick={clearSearchAndFilters}
            aria-current={!hasFilters ? "page" : undefined}
            className={`sidebar-link${!hasFilters ? " is-active" : ""}`}
          >
            <Library size={18} strokeWidth={1.6} />
            <span>All books</span>
            <span className="nav-count">{count(stats?.totalBooks)}</span>
          </button>
          {recentCount > 0 && (
            <a href="#recently-read" className="sidebar-link">
              <Clock3 size={18} strokeWidth={1.6} />
              <span>Recently read</span>
              <span className="nav-count">{recentCount}</span>
            </a>
          )}
          <Link to="/settings" className="sidebar-link">
            <Settings size={18} strokeWidth={1.6} />
            <span>Settings</span>
          </Link>
        </nav>
        {(tags?.length ?? 0) > 0 && (
          <>
            <div className="sidebar-section-heading">
              <span>Browse by tag</span>
              <Tags size={14} strokeWidth={1.6} />
            </div>
            <nav className="sidebar-nav" id="sidebar-tag-list" aria-label="Tags">
              {sidebarTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={tagIds.includes(tag.id)}
                  onClick={() =>
                    setTags(
                      tagIds.includes(tag.id)
                        ? tagIds.filter((id) => id !== tag.id)
                        : [...tagIds, tag.id],
                    )
                  }
                  className={`sidebar-link tag-link${tagIds.includes(tag.id) ? " is-active" : ""}`}
                >
                  <span className="tag-dot" />
                  <span className="truncate">{tag.name}</span>
                  <span className="nav-count">{tag.bookCount.toLocaleString()}</span>
                </button>
              ))}
            </nav>
            {hasMoreSidebarTags && (
              <button
                type="button"
                className="sidebar-tag-toggle"
                aria-controls="sidebar-tag-list"
                aria-expanded={showAllTags}
                onClick={() => setShowAllTags((expanded) => !expanded)}
              >
                <span>
                  {showAllTags ? "Show fewer tags" : `Show all ${tags?.length ?? 0} tags`}
                </span>
                {showAllTags ? (
                  <ChevronUp size={14} strokeWidth={1.6} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} strokeWidth={1.6} aria-hidden="true" />
                )}
              </button>
            )}
          </>
        )}
        <div className="sidebar-note">
          <BookOpen size={24} strokeWidth={1.3} />
          <p>
            A little less scrolling.
            <br />A little more reading.
          </p>
          <a href="/opds">
            Connect your reading app <ArrowUpRight size={14} />
          </a>
        </div>
        <div className="sidebar-library">
          <span className="connection-dot" />
          <div>
            <p className="truncate" title={libraryConfig.libraryPath}>
              {libraryName}
            </p>
            <span>Your library, on your device</span>
          </div>
        </div>
      </aside>

      <div className="library-workspace">
        <header className="library-topbar">
          <a href="#main-content" className="mobile-brand">
            <Library size={20} />
            <span>caliber.</span>
          </a>
          <div className="topbar-breadcrumb">
            <FolderOpen size={16} strokeWidth={1.6} />
            <span>My library</span>
            <span className="breadcrumb-divider">/</span>
            <span>Overview</span>
          </div>
          <div className="topbar-actions">
            <span className="library-status">
              <span className="connection-dot" />
              Library connected
            </span>
            <UserMenu />
            <Link to="/settings" className="mobile-settings" aria-label="Settings">
              <Settings size={19} />
            </Link>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="library-main">
          <section className="library-intro" aria-labelledby="library-title">
            <div>
              <p className="eyebrow">A home for your books</p>
              <h1 id="library-title" className="display-title">
                Your next chapter<span>.</span>
              </h1>
              <p className="intro-description">Old favorites, new discoveries. All within reach.</p>
            </div>
            <fieldset className="library-statistics" aria-label="Library statistics">
              <div>
                <strong>{count(stats?.totalBooks)}</strong>
                <span>Books</span>
              </div>
              <div>
                <strong>{count(stats?.totalAuthors)}</strong>
                <span>Authors</span>
              </div>
              <div>
                <strong>{count(stats?.totalSeries)}</strong>
                <span>Series</span>
              </div>
            </fieldset>
          </section>

          <RecentlyRead libraryId={libraryConfig.libraryId} />

          <section className="catalogue-section" aria-label="Book catalogue">
            <div className="catalogue-heading">
              <div>
                <h2>{hasFilters ? "Find your next read" : "The bookshelf"}</h2>
                <p>
                  {hasFilters
                    ? "Explore the books that match your search and filters."
                    : "A good book is always waiting."}
                </p>
              </div>
              <span className="collection-label">
                <BookOpen size={15} strokeWidth={1.6} />
                Personal collection
              </span>
            </div>
            <div ref={toolbarRef} className="catalogue-toolbar">
              <div className="catalogue-controls">
                <div className="catalogue-search">
                  <BookSearch onSearch={setSearchQuery} initialValue={search.q} />
                </div>
                <div className="catalogue-filters">
                  <TagFilter
                    tags={tags}
                    selectedIds={tagIds}
                    onChange={setTags}
                    isLoading={tagsLoading}
                    error={tagsError}
                    onRetry={() => void refetchTags()}
                  />
                  <FormatFilter
                    formats={formats}
                    selected={search.format}
                    onChange={setFormats}
                    isLoading={formatsLoading}
                    error={formatsError}
                    onRetry={() => void refetchFormats()}
                  />
                </div>
                <div className="catalogue-view-controls">
                  <label className="sr-only" htmlFor="library-sort">
                    Sort books
                  </label>
                  <select
                    id="library-sort"
                    className="catalogue-sort"
                    value={`${sortConfig.field}:${sortConfig.order}`}
                    onChange={(event) => {
                      const [field, order] = event.target.value.split(":");
                      setSortConfig({ field: field as SortField, order: order as SortOrder });
                    }}
                  >
                    <option value="added:desc">Recently added</option>
                    <option value="added:asc">Oldest added</option>
                    <option value="title:asc">Title: A–Z</option>
                    <option value="title:desc">Title: Z–A</option>
                    <option value="author:asc">Author: A–Z</option>
                    <option value="author:desc">Author: Z–A</option>
                    <option value="rating:desc">Highest rated</option>
                    <option value="rating:asc">Lowest rated</option>
                  </select>
                  <fieldset aria-label="View mode" className="view-switch">
                    <button
                      type="button"
                      onClick={() => updateSearch({ view: "grid" })}
                      aria-pressed={search.view === "grid"}
                      aria-label="Grid view"
                      title="Grid view"
                    >
                      <LayoutGrid size={17} strokeWidth={1.7} />
                    </button>
                    <button
                      type="button"
                      onClick={() => updateSearch({ view: "list" })}
                      aria-pressed={search.view === "list"}
                      aria-label="List view"
                      title="List view"
                    >
                      <List size={18} strokeWidth={1.7} />
                    </button>
                  </fieldset>
                  {search.view === "list" && (
                    <button
                      type="button"
                      onClick={toggleDensity}
                      aria-pressed={density === "compact"}
                      aria-label="Compact density"
                      title="Compact density"
                      className="density-toggle"
                    >
                      <Rows3 size={17} />
                    </button>
                  )}
                </div>
              </div>
              <div className="selected-filter-row">
                <SelectedTagChips
                  selectedIds={tagIds}
                  tags={tags}
                  onRemove={(id) => setTags(tagIds.filter((tag) => tag !== id))}
                  onClear={() => setTags([])}
                />
                <SelectedFormatChips
                  selected={search.format}
                  onRemove={(format) => setFormats(search.format.filter((name) => name !== format))}
                  onClear={() => setFormats([])}
                />
              </div>
            </div>
            {search.view === "list" ? (
              <>
                <div className="catalogue-table-header" style={{ top: toolbarHeight }}>
                  <TableHeader sortConfig={sortConfig} onSortChange={setSortConfig} />
                </div>
                <div className="catalogue-table">
                  <BookTableInfinite
                    searchQuery={search.q}
                    sortConfig={sortConfig}
                    tagIds={tagIds}
                    formats={search.format}
                    onClearFilters={clearSearchAndFilters}
                    stickyOffset={toolbarHeight + 64}
                    rowHeight={density === "compact" ? 56 : 72}
                    libraryId={libraryConfig.libraryId}
                  />
                </div>
              </>
            ) : (
              <div className="catalogue-grid">
                <BookGridInfinite
                  searchQuery={search.q}
                  sortConfig={sortConfig}
                  tagIds={tagIds}
                  formats={search.format}
                  onClearFilters={clearSearchAndFilters}
                  stickyOffset={toolbarHeight + 16}
                  libraryId={libraryConfig.libraryId}
                />
              </div>
            )}
          </section>
          <footer className="library-footer">
            <span>Made for the love of reading.</span>
            <span>
              <Check size={13} />
              Your Calibre library stays untouched
            </span>
          </footer>
        </main>
      </div>
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
      <main
        id="main-content"
        tabIndex={-1}
        className="max-w-xl mx-auto px-4 sm:px-6 pt-12 sm:pt-24 pb-16"
      >
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

// Removable chips for the currently selected formats. Rendered inside the
// sticky toolbar next to the tag chips; the URL (`?format=`) remains the
// source of truth — chips only call onRemove/onClear.
function SelectedFormatChips({
  selected,
  onRemove,
  onClear,
}: {
  selected: string[];
  onRemove: (name: string) => void;
  onClear: () => void;
}) {
  if (selected.length === 0) return null;
  return (
    <ul
      className="mt-2 flex flex-wrap items-center gap-1.5 list-none m-0 p-0"
      aria-label="Selected file types"
    >
      {selected.map((name) => (
        <li
          key={name}
          className="inline-flex items-center gap-1 rounded-full border border-ink bg-surface py-1 pl-2.5 pr-1.5 text-xs font-medium text-ink"
        >
          <span className="font-mono uppercase">{name}</span>
          <button
            type="button"
            onClick={() => onRemove(name)}
            aria-label={`Remove ${name} filter`}
            className="flex h-5 w-5 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-parchment-dark hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-3 w-3" strokeWidth={2.5} />
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear all selected file types"
          className="text-xs font-semibold text-accent hover:text-accent-hover transition-colors"
        >
          Clear all
        </button>
      </li>
    </ul>
  );
}
