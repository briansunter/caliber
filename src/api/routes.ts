import {
  listBooksHandler,
  searchBooksHandler,
  getBookHandler,
  downloadBookHandler,
  getCoverHandler,
} from "./handlers/books";

type GenericRouteHandler = (
  req: Request & { params: Record<string, string> }
) => Promise<Response>;

export const apiRoutes: Record<string, Record<string, GenericRouteHandler>> = {
  "/api/books": {
    GET: listBooksHandler as GenericRouteHandler,
  },
  "/api/books/search": {
    GET: searchBooksHandler as GenericRouteHandler,
  },
  "/api/books/:id": {
    GET: getBookHandler as GenericRouteHandler,
  },
  "/api/books/:id/download/:format": {
    GET: downloadBookHandler as GenericRouteHandler,
  },
  "/api/books/:id/cover": {
    GET: getCoverHandler as GenericRouteHandler,
  },
};
