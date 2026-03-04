import {
  listBooks,
  searchBooks,
  getBookById,
  bookHasFormat,
  getFormatPath,
  getCoverPath,
} from "../../lib/calibre";

type RouteRequest<TParams extends Record<string, string>> = Request & {
  params: TParams;
};

export async function listBooksHandler(
  req: Request
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const perPage = parseInt(url.searchParams.get("perPage") || "20", 10);

    const validPage = Math.max(1, page);
    const validPerPage = Math.min(100, Math.max(1, perPage));

    const result = listBooks(validPage, validPerPage);

    return Response.json(result);
  } catch (error) {
    console.error("Error listing books:", error);
    return Response.json(
      { error: "Failed to list books" },
      { status: 500 }
    );
  }
}

export async function searchBooksHandler(
  req: Request
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const query = url.searchParams.get("q");

    if (!query || query.trim().length === 0) {
      return Response.json(
        { error: "Search query is required" },
        { status: 400 }
      );
    }

    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const perPage = parseInt(url.searchParams.get("perPage") || "20", 10);

    const validPage = Math.max(1, page);
    const validPerPage = Math.min(100, Math.max(1, perPage));

    const result = searchBooks(query.trim(), validPage, validPerPage);

    return Response.json(result);
  } catch (error) {
    console.error("Error searching books:", error);
    return Response.json(
      { error: "Failed to search books" },
      { status: 500 }
    );
  }
}

export async function getBookHandler(
  req: RouteRequest<{ id: string }>
): Promise<Response> {
  try {
    const id = parseInt(req.params.id, 10);

    if (Number.isNaN(id)) {
      return Response.json(
        { error: "Invalid book ID" },
        { status: 400 }
      );
    }

    const book = getBookById(id);

    if (!book) {
      return Response.json(
        { error: "Book not found" },
        { status: 404 }
      );
    }

    return Response.json(book);
  } catch (error) {
    console.error("Error getting book:", error);
    return Response.json(
      { error: "Failed to get book" },
      { status: 500 }
    );
  }
}

export async function downloadBookHandler(
  req: RouteRequest<{ id: string; format: string }>
): Promise<Response> {
  try {
    const id = parseInt(req.params.id, 10);
    const format = req.params.format.toUpperCase();

    if (Number.isNaN(id)) {
      return Response.json(
        { error: "Invalid book ID" },
        { status: 400 }
      );
    }

    const book = getBookById(id);

    if (!book) {
      return Response.json(
        { error: "Book not found" },
        { status: 404 }
      );
    }

    if (!bookHasFormat(id, format)) {
      return Response.json(
        { error: `Book does not have ${format} format` },
        { status: 404 }
      );
    }

    const filePath = getFormatPath(book, format);

    if (!filePath) {
      return Response.json(
        { error: "File not found" },
        { status: 404 }
      );
    }

    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      return Response.json(
        { error: "File not found on disk" },
        { status: 404 }
      );
    }

    const ext = format.toLowerCase();
    const contentTypeMap: Record<string, string> = {
      epub: "application/epub+zip",
      mobi: "application/x-mobipocket-ebook",
      azw3: "application/vnd.amazon.ebook",
      pdf: "application/pdf",
      txt: "text/plain",
      html: "text/html",
      rtf: "application/rtf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };

    const contentType = contentTypeMap[ext] || "application/octet-stream";
    const safeTitle = book.title.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "_");
    const filename = `${safeTitle}.${ext}`;

    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("Error downloading book:", error);
    return Response.json(
      { error: "Failed to download book" },
      { status: 500 }
    );
  }
}

export async function getCoverHandler(
  req: RouteRequest<{ id: string }>
): Promise<Response> {
  try {
    const id = parseInt(req.params.id, 10);

    if (Number.isNaN(id)) {
      return Response.json(
        { error: "Invalid book ID" },
        { status: 400 }
      );
    }

    const book = getBookById(id);

    if (!book) {
      return Response.json(
        { error: "Book not found" },
        { status: 404 }
      );
    }

    if (!book.has_cover) {
      return Response.json(
        { error: "Book has no cover" },
        { status: 404 }
      );
    }

    const coverPath = getCoverPath(book);

    if (!coverPath) {
      return Response.json(
        { error: "Cover not found" },
        { status: 404 }
      );
    }

    const file = Bun.file(coverPath);

    if (!(await file.exists())) {
      return Response.json(
        { error: "Cover file not found on disk" },
        { status: 404 }
      );
    }

    return new Response(file, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("Error getting cover:", error);
    return Response.json(
      { error: "Failed to get cover" },
      { status: 500 }
    );
  }
}
