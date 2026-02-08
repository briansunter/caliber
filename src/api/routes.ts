import type { Serve } from "bun";
import {
  listBooksHandler,
  searchBooksHandler,
  getBookHandler,
  downloadBookHandler,
  getCoverHandler,
} from "./handlers/books";

export const apiRoutes: Record<
  string,
  Record<
    string,
    (req: Parameters<Serve["fetch"]>[0] & { params: Record<string, string> }) => Promise<Response>
  >
> = {
  "/api/books": {
    GET: listBooksHandler,
  },
  "/api/books/search": {
    GET: searchBooksHandler,
  },
  "/api/books/:id": {
    GET: getBookHandler,
  },
  "/api/books/:id/download/:format": {
    GET: downloadBookHandler,
  },
  "/api/books/:id/cover": {
    GET: getCoverHandler,
  },
};
