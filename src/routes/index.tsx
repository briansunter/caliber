import { createFileRoute } from "@tanstack/react-router";
import { BookTableInfinite, TableHeader } from "@/components/BookTableInfinite";
import { BookSearch } from "@/components/BookSearch";
import { useState } from "react";
import { BookOpen, Users, Layers, Library } from "lucide-react";
import { useLibraryStats, type SortConfig } from "@/hooks/useBooksInfinite";

export const Route = createFileRoute("/")({
  component: IndexComponent,
});

function IndexComponent() {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    field: "title",
    order: "asc",
  });
  const { data: stats, isLoading: statsLoading } = useLibraryStats();

  return (
    <div className="min-h-screen bg-parchment paper-texture">
      {/* Fixed Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-ink bg-white/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-ink rounded-lg flex items-center justify-center">
                <Library className="h-4 w-4 text-white" strokeWidth={1.5} />
              </div>
              <div>
                <h1 className="text-base font-semibold text-ink tracking-tight">
                  Caliber
                </h1>
                <p className="text-xs text-ink-muted">Library</p>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-ink-muted text-sm">
              <span className="w-2 h-2 rounded-full bg-success"></span>
              <span>Connected</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content - Unified Scroll */}
      <main className="max-w-7xl mx-auto px-6 pt-20 pb-10">
        {/* Welcome Section */}
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">
            Your Collection
          </h2>
          <p className="text-sm text-ink-tertiary max-w-2xl">
            Browse, search, and download from your personal digital library.
            {stats?.totalBooks && ` ${stats.totalBooks.toLocaleString()} volumes.`}
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
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

        {/* Search Bar - Sticky below header */}
        <div className="sticky top-[57px] z-40 -mx-2 px-2 py-2.5 bg-parchment/95 backdrop-blur-sm border-y border-ink">
          <BookSearch onSearch={setSearchQuery} />
        </div>

        {/* Table Header - Sticky below search, no double border */}
        <div className="sticky top-[117px] z-50 bg-parchment-dark">
          <TableHeader sortConfig={sortConfig} onSortChange={setSortConfig} />
        </div>

        {/* Table Section - Card with scrollable content */}
        <div className="bg-white border-x border-b border-ink rounded-b-lg shadow-sm">
          {/* Table Content */}
          <BookTableInfinite
            searchQuery={searchQuery}
            sortConfig={sortConfig}
          />
        </div>
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

function StatCard({ icon, value, label }: StatCardProps) {
  return (
    <div className="stat-card flex items-center gap-3">
      <div className="w-10 h-10 bg-parchment-dark rounded-lg flex items-center justify-center border border-ink">
        {icon}
      </div>
      <div>
        <p className="stat-value">{value}</p>
        <p className="stat-label">{label}</p>
      </div>
    </div>
  );
}
