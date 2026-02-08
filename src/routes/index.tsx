import { createFileRoute } from "@tanstack/react-router";
import { BookTableInfinite } from "@/components/BookTableInfinite";
import { BookSearch } from "@/components/BookSearch";
import { useState } from "react";
import { Library, BookOpen, Users, Layers } from "lucide-react";
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
    <div className="min-h-screen bg-primary">
      {/* Header */}
      <header className="border-b border-default">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-dim rounded-lg flex items-center justify-center">
              <Library className="h-5 w-5 text-accent" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-primary">Caliber</h1>
              <p className="text-xs text-tertiary">Personal Library Manager</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <StatCard
            icon={<BookOpen className="h-5 w-5 text-accent" />}
            value={statsLoading ? "—" : stats?.totalBooks.toLocaleString() || "0"}
            label="Books"
          />
          <StatCard
            icon={<Users className="h-5 w-5 text-accent" />}
            value={statsLoading ? "—" : stats?.totalAuthors.toLocaleString() || "0"}
            label="Authors"
          />
          <StatCard
            icon={<Layers className="h-5 w-5 text-accent" />}
            value={statsLoading ? "—" : stats?.totalSeries.toLocaleString() || "0"}
            label="Series"
          />
        </div>

        {/* Search */}
        <div className="mb-6">
          <BookSearch onSearch={setSearchQuery} />
        </div>

        {/* Table */}
        <div className="card overflow-hidden">
          <BookTableInfinite
            searchQuery={searchQuery}
            sortConfig={sortConfig}
            onSortChange={setSortConfig}
          />
        </div>
      </main>
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
    <div className="card p-4 flex items-center gap-4">
      <div className="w-12 h-12 bg-accent-dim rounded-xl flex items-center justify-center">
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold text-primary">{value}</p>
        <p className="text-sm text-tertiary">{label}</p>
      </div>
    </div>
  );
}
