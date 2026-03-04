import { useRef, useState, memo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type Row,
  type Column,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSearch } from "@/hooks/useSearch";
import type { BookListItem } from "@/types/calibre";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  BookOpen,
  Library,
  Star,
  Search,
  Loader2,
  ChevronRight,
} from "lucide-react";

interface BookTableProps {
  searchQuery: string;
}

const columnHelper = createColumnHelper<BookListItem>();

const COLUMN_WIDTHS = {
  title: "minmax(300px, 3fr)",
  authors: "minmax(160px, 1.5fr)",
  series: "minmax(140px, 1.2fr)",
  tags: "minmax(180px, 1.5fr)",
  rating: "90px",
  formats: "minmax(100px, 1fr)",
  actions: "60px",
};

const GRID_TEMPLATE = `${COLUMN_WIDTHS.title} ${COLUMN_WIDTHS.authors} ${COLUMN_WIDTHS.series} ${COLUMN_WIDTHS.tags} ${COLUMN_WIDTHS.rating} ${COLUMN_WIDTHS.formats} ${COLUMN_WIDTHS.actions}`;

const ROW_HEIGHT = 72;

// Star rating component
const StarRating = memo(function StarRating({ rating }: { rating?: number | null }) {
  if (!rating) return <span className="text-muted">—</span>;

  const stars = [];
  const fullStars = Math.floor(rating / 2);
  const hasHalfStar = rating % 2 >= 1;

  for (let i = 0; i < 5; i++) {
    if (i < fullStars) {
      stars.push(<Star key={i} className="h-4 w-4 fill-accent text-accent" />);
    } else if (i === fullStars && hasHalfStar) {
      stars.push(
        <div key={i} className="relative">
          <Star className="h-4 w-4 text-border-strong" />
          <div className="absolute inset-0 overflow-hidden w-1/2">
            <Star className="h-4 w-4 fill-accent text-accent" />
          </div>
        </div>
      );
    } else {
      stars.push(<Star key={i} className="h-4 w-4 text-border-strong" />);
    }
  }

  return <div className="flex items-center gap-0.5">{stars}</div>;
});

// Cell components
const TitleCell = memo(function TitleCell({ title, id, hasCover }: { title: string; id: number; hasCover?: boolean }) {
  return (
    <Link to="/book/$id" params={{ id: String(id) }} className="group flex items-center gap-3">
      <div
        className="relative flex-shrink-0 w-9 h-12 rounded bg-tertiary overflow-hidden flex items-center justify-center"
        style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}
      >
        <BookOpen className="h-4 w-4 text-muted" />
        {hasCover && <div className="absolute bottom-0 left-0 right-0 h-1 bg-accent" />}
      </div>
      <span className="font-medium text-primary group-hover:text-accent transition-colors line-clamp-2">
        {title}
      </span>
    </Link>
  );
});

const AuthorsCell = memo(function AuthorsCell({ authors }: { authors?: string[] }) {
  if (!authors || authors.length === 0) {
    return <span className="text-muted">Unknown</span>;
  }
  return <span className="text-secondary">{authors.join(", ")}</span>;
});

const SeriesCell = memo(function SeriesCell({
  series,
  seriesIndex,
}: {
  series?: string | null;
  seriesIndex?: number;
}) {
  if (!series) return <span className="text-muted">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-secondary">{series}</span>
      <span className="text-xs text-tertiary">Book {seriesIndex || 1}</span>
    </div>
  );
});

const TagsCell = memo(function TagsCell({ tags }: { tags?: string[] }) {
  if (!tags || tags.length === 0) return <span className="text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.slice(0, 2).map((tag) => (
        <span key={tag} className="badge">
          {tag}
        </span>
      ))}
      {tags.length > 2 && <span className="text-xs text-tertiary">+{tags.length - 2}</span>}
    </div>
  );
});

const FormatsCell = memo(function FormatsCell({ formats }: { formats?: string[] }) {
  if (!formats || formats.length === 0) return <span className="text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {formats.map((fmt) => (
        <span
          key={fmt}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-tertiary text-tertiary border border-default"
        >
          {fmt}
        </span>
      ))}
    </div>
  );
});

const ActionsCell = memo(function ActionsCell({ id }: { id: number }) {
  return (
    <Link to="/book/$id" params={{ id: String(id) }}>
      <button
        type="button"
        className="p-2 rounded-md hover:bg-tertiary text-tertiary hover:text-primary transition-colors"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </Link>
  );
});

// Sortable header
interface SortableHeaderProps {
  column: Column<BookListItem, unknown>;
  title: string;
}

const SortableHeader = memo(function SortableHeader({ column, title }: SortableHeaderProps) {
  const isSorted = column.getIsSorted();

  return (
    <button
      type="button"
      onClick={() => column.toggleSorting()}
      className="flex items-center gap-1.5 text-xs font-semibold text-tertiary uppercase tracking-wider hover:text-primary transition-colors"
    >
      {title}
      <span className="text-muted">
        {isSorted === "asc" ? (
          <ArrowUp className="h-3 w-3 text-accent" />
        ) : isSorted === "desc" ? (
          <ArrowDown className="h-3 w-3 text-accent" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-50" />
        )}
      </span>
    </button>
  );
});

const columns = [
  columnHelper.accessor("title", {
    header: ({ column }) => <SortableHeader column={column} title="Title" />,
    cell: (info) => (
      <TitleCell title={info.getValue()} id={info.row.original.id} hasCover={info.row.original.has_cover} />
    ),
    sortingFn: (rowA, rowB) => rowA.original.title.localeCompare(rowB.original.title),
  }),
  columnHelper.accessor("authors", {
    header: ({ column }) => <SortableHeader column={column} title="Author" />,
    cell: (info) => <AuthorsCell authors={info.getValue()} />,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.author_sort || rowA.original.authors?.[0] || "";
      const b = rowB.original.author_sort || rowB.original.authors?.[0] || "";
      return a.localeCompare(b);
    },
  }),
  columnHelper.accessor("series", {
    header: ({ column }) => <SortableHeader column={column} title="Series" />,
    cell: (info) => <SeriesCell series={info.getValue()} seriesIndex={info.row.original.series_index} />,
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.series || "";
      const b = rowB.original.series || "";
      return a.localeCompare(b);
    },
  }),
  columnHelper.accessor("tags", {
    header: () => <span className="text-xs font-semibold text-tertiary uppercase tracking-wider">Tags</span>,
    cell: (info) => <TagsCell tags={info.getValue()} />,
  }),
  columnHelper.accessor("rating", {
    header: ({ column }) => <SortableHeader column={column} title="Rating" />,
    cell: (info) => <StarRating rating={info.getValue()} />,
  }),
  columnHelper.accessor("formats", {
    header: () => <span className="text-xs font-semibold text-tertiary uppercase tracking-wider">Formats</span>,
    cell: (info) => <FormatsCell formats={info.getValue()} />,
  }),
  columnHelper.display({
    id: "actions",
    header: "",
    cell: ({ row }) => <ActionsCell id={row.original.id} />,
  }),
];

// Virtual row
interface VirtualRowProps {
  row: Row<BookListItem>;
  style: React.CSSProperties;
}

const VirtualRow = memo(function VirtualRow({ row, style }: VirtualRowProps) {
  const cells = row.getVisibleCells();

  return (
    <div
      style={style}
      className="absolute left-0 w-full flex items-center px-4 border-b border-subtle hover:bg-tertiary transition-colors"
    >
      <div
        className="w-full h-full items-center"
        style={{ display: "grid", gridTemplateColumns: GRID_TEMPLATE, gap: "1rem" }}
      >
        {cells.map((cell) => (
          <div key={cell.id} className="flex items-center min-w-0 py-3">
            <div className="truncate w-full">{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
          </div>
        ))}
      </div>
    </div>
  );
});

// Empty state
const EmptyState = memo(function EmptyState({ searchQuery }: { searchQuery: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-8">
      <div className="w-14 h-14 rounded-full bg-tertiary flex items-center justify-center mb-4">
        <Search className="h-6 w-6 text-muted" />
      </div>
      <h3 className="text-lg font-semibold text-primary mb-1">No books found</h3>
      <p className="text-secondary">
        {searchQuery
          ? `No books match "${searchQuery}". Try a different search term.`
          : "Your library is empty. Add some books to get started."}
      </p>
    </div>
  );
});

export function BookTable({ searchQuery }: BookTableProps) {
  const { data: books = [], isLoading, error } = useSearch(searchQuery);
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data: books,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const { rows } = table.getRowModel();
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-secondary">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading your library...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-8">
        <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mb-4">
          <Library className="h-6 w-6 text-error" />
        </div>
        <h3 className="text-lg font-semibold text-primary mb-1">Failed to load books</h3>
        <p className="text-secondary">{error.message}</p>
      </div>
    );
  }

  if (books.length === 0) {
    return <EmptyState searchQuery={searchQuery} />;
  }

  return (
    <div className="overflow-hidden">
      {/* Header */}
      <div className="table-header sticky top-0 z-10">
        <div className="px-4 h-12 items-center" style={{ display: "grid", gridTemplateColumns: GRID_TEMPLATE, gap: "1rem" }}>
          {table.getHeaderGroups().map((headerGroup) =>
            headerGroup.headers.map((header) => (
              <div key={header.id} className="flex items-center">
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Virtual scroll container */}
      <div ref={parentRef} className="overflow-auto" style={{ height: "500px" }}>
        <div style={{ height: `${totalSize}px`, position: "relative" }}>
          {virtualItems.map((virtualItem) => {
            const row = rows[virtualItem.index];
            if (!row) return null;
            return (
              <VirtualRow
                key={row.id}
                row={row}
                style={{
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-default bg-secondary flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Library className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium text-primary">
            {books.length.toLocaleString()} book{books.length !== 1 ? "s" : ""}
          </span>
          <span className="text-sm text-tertiary">
            {searchQuery ? `matching "${searchQuery}"` : "in your library"}
          </span>
        </div>
        <div className="text-xs text-tertiary uppercase tracking-wider">
          Sorted by {sorting.length > 0 && sorting[0] ? sorting[0].id : "title"}
        </div>
      </div>
    </div>
  );
}
