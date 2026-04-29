import { createFileRoute } from "@tanstack/react-router";
import { BookTableInfinite, TableHeader, SortHeader } from "@/components/BookTableInfinite";
import { BookGridInfinite } from "@/components/BookGridInfinite";
import { BookSearch } from "@/components/BookSearch";
import { useState, useCallback, useEffect, useRef } from "react";
import { BookOpen, Users, Layers, Library, LayoutGrid, List } from "lucide-react";
import { useLibraryStats, type SortConfig, type SortField } from "@/hooks/useBooksInfinite";

type ViewMode = "list" | "grid";

const STORAGE_KEY = "caliber-ui";
const SCROLL_KEY = "caliber-scroll";

interface UIState {
  view: ViewMode;
  sort: SortConfig;
  search: string;
}

function loadUIState(): UIState {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  const defaultView = window.innerWidth < 768 ? "grid" : "list";
  return { view: defaultView, sort: { field: "title", order: "asc" }, search: "" };
}

function saveUIState(state: UIState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function saveScrollPos() {
  try {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  } catch {}
}

function popScrollPos(): number | null {
  try {
    const v = sessionStorage.getItem(SCROLL_KEY);
    sessionStorage.removeItem(SCROLL_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/")({
  component: IndexComponent,
});

function IndexComponent() {
  const [uiState, setUIState] = useState(loadUIState);
  const searchQuery = uiState.search;
  const viewMode = uiState.view;
  const sortConfig = uiState.sort;

  const setSearchQuery = useCallback((q: string) => {
    setUIState((prev) => {
      const next = { ...prev, search: q };
      saveUIState(next);
      return next;
    });
  }, []);

  const setViewMode = useCallback((v: ViewMode) => {
    setUIState((prev) => {
      const next = { ...prev, view: v };
      saveUIState(next);
      return next;
    });
  }, []);

  const setSortConfig = useCallback((config: SortConfig) => {
    setUIState((prev) => {
      const next = { ...prev, sort: config };
      saveUIState(next);
      return next;
    });
  }, []);

  // Save scroll position on any click that navigates away
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest("a[href]");
      if (link && !link.getAttribute("href")?.startsWith("#")) {
        saveScrollPos();
      }
    };
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  // Restore scroll position after data is ready
  const scrollRestored = useRef(false);
  const savedScroll = useRef(popScrollPos());
  useEffect(() => {
    if (!scrollRestored.current && savedScroll.current && savedScroll.current > 0) {
      const target = savedScroll.current;
      // Retry scroll until the page is tall enough or timeout
      let attempts = 0;
      const tryScroll = () => {
        if (document.documentElement.scrollHeight >= target + 100 || attempts > 20) {
          window.scrollTo(0, target);
          scrollRestored.current = true;
        } else {
          attempts++;
          requestAnimationFrame(tryScroll);
        }
      };
      requestAnimationFrame(tryScroll);
    }
  });

  const { data: stats, isLoading: statsLoading } = useLibraryStats();

  return (
    <div className="min-h-screen bg-parchment paper-texture">
      {/* Main Content - Unified Scroll */}
      <main className="max-w-7xl mx-auto px-3 sm:px-6 pt-4 sm:pt-8 pb-10">
        {/* Welcome Section */}
        <div className="mb-3 sm:mb-6">
          <div className="flex items-center gap-2 sm:gap-3 mb-1 sm:mb-2">
            <div className="w-7 h-7 sm:w-9 sm:h-9 bg-ink rounded-lg flex items-center justify-center">
              <Library className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-white" strokeWidth={1.5} />
            </div>
            <h1 className="text-lg sm:text-2xl font-semibold text-ink tracking-tight">Caliber</h1>
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

        {/* Search Bar + View Toggle - Sticky at top */}
        <div className="sticky top-0 z-40 -mx-1 sm:-mx-2 px-1 sm:px-2 py-1.5 sm:py-2.5 bg-parchment border-y border-ink-strong shadow-sm">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex-1 min-w-0">
              <BookSearch onSearch={setSearchQuery} initialValue={searchQuery} />
            </div>
            <div className="flex-shrink-0 flex items-center border border-ink rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`p-2 transition-colors ${viewMode === "list" ? "bg-ink text-white" : "bg-white text-ink-muted hover:text-ink"}`}
                title="List view"
              >
                <List className="h-4 w-4" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`p-2 transition-colors ${viewMode === "grid" ? "bg-ink text-white" : "bg-white text-ink-muted hover:text-ink"}`}
                title="Grid view"
              >
                <LayoutGrid className="h-4 w-4" strokeWidth={1.5} />
              </button>
            </div>
          </div>
          {viewMode === "grid" && (
            <GridSortBar sortConfig={sortConfig} onSortChange={setSortConfig} />
          )}
        </div>

        {viewMode === "list" && (
          <>
            {/* Table Header - Sticky below search */}
            <div className="sticky top-[46px] sm:top-[56px] z-30 bg-parchment-dark">
              <TableHeader sortConfig={sortConfig} onSortChange={setSortConfig} />
            </div>

            {/* Table Section */}
            <div className="bg-white border-x border-b border-ink rounded-b-lg shadow-sm">
              <BookTableInfinite searchQuery={searchQuery} sortConfig={sortConfig} />
            </div>
          </>
        )}

        {viewMode === "grid" && (
          <div className="bg-white border-x border-b border-ink rounded-b-lg shadow-sm pt-4">
            <BookGridInfinite searchQuery={searchQuery} sortConfig={sortConfig} />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-ink bg-white">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="ornament text-ink-muted">
            <span className="text-sm">Caliber Library Manager</span>
          </div>
        </div>
      </footer>
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
