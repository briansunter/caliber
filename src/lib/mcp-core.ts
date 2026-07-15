import {
  searchBooksByTitle,
  searchBooksByAuthor,
  getAuthorByName,
  searchBooksCursor,
} from "./calibre-optimized";
import { formatBook } from "./mcp-utils";

export interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const serverCapabilities = {
  protocolVersion: "2024-11-05",
  serverInfo: {
    name: "caliber-library-search",
    version: "1.0.0",
  },
  capabilities: {
    tools: {
      listChanged: false,
    },
  },
};

export const tools: MCPTool[] = [
  {
    name: "search_book_title",
    description:
      "Search the local library for books by title. Returns matching books with authors, series, and formats.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The book title to search for (partial matches supported)",
        },
        count: {
          type: "number",
          description: "Maximum number of results to return",
          default: 10,
        },
      },
      required: ["title"],
    },
  },
  {
    name: "search_author",
    description:
      "Search the local library for books by author name. Returns all books by matching authors.",
    inputSchema: {
      type: "object",
      properties: {
        author: {
          type: "string",
          description: "The author name to search for (partial matches supported)",
        },
        count: {
          type: "number",
          description: "Maximum number of results to return",
          default: 10,
        },
      },
      required: ["author"],
    },
  },
  {
    name: "search_library",
    description:
      "General search across the local library (title, author, series). Returns matching books.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find books",
        },
        count: {
          type: "number",
          description: "Maximum number of results to return",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
];

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const countArg = typeof args.count === "number" && Number.isFinite(args.count) ? args.count : 10;
  const count = Math.min(20, Math.max(1, Math.floor(countArg)));

  switch (name) {
    case "search_book_title": {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) throw new Error("title must be a non-empty string");

      const books = searchBooksByTitle(title, count);

      let output = `Library search for title: "${title}"\n`;
      output += `${"=".repeat(60)}\n\n`;

      if (books.length === 0) {
        output += "No books found with that title.\n";
      } else {
        output += `Found ${books.length} book(s):\n\n`;
        for (const [i, book] of books.entries()) {
          output += `${i + 1}. ${formatBook(book)}\n`;
        }
      }

      return output;
    }

    case "search_author": {
      const author = typeof args.author === "string" ? args.author.trim() : "";
      if (!author) throw new Error("author must be a non-empty string");

      const authorInfo = getAuthorByName(author);
      const books = searchBooksByAuthor(author, count);

      let output = `Library search for author: "${author}"\n`;
      output += `${"=".repeat(60)}\n\n`;

      if (authorInfo) {
        output += `Author: ${authorInfo.name} (${authorInfo.bookCount} book(s) in library)\n\n`;
      }

      if (books.length === 0) {
        output += "No books found by that author.\n";
      } else {
        output += `Showing ${books.length} book(s):\n\n`;
        for (const [i, book] of books.entries()) {
          output += `${i + 1}. ${formatBook(book)}\n`;
        }
      }

      return output;
    }

    case "search_library": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("query must be a non-empty string");

      const result = searchBooksCursor({ query, limit: count });

      let output = `Library search: "${query}"\n`;
      output += `${"=".repeat(60)}\n\n`;

      if (result.items.length === 0) {
        output += "No books found matching that query.\n";
      } else {
        output += `Found ${result.items.length} book(s):\n\n`;
        for (const [i, item] of result.items.entries()) {
          output += `${i + 1}. ${formatBook(item)}\n`;
        }
      }

      return output;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleJSONRPC(request: MCPRequest): Promise<MCPResponse | null> {
  if (request.id === undefined || request.id === null) {
    return null;
  }

  const id = request.id;

  switch (request.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: serverCapabilities,
      };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools },
      };
    }

    case "tools/call": {
      if (typeof request.params !== "object" || request.params === null) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid tool call parameters" },
        };
      }
      const params = request.params as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string" || params.name.length === 0) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Tool name is required" },
        };
      }
      const args =
        typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      try {
        const result = await executeTool(params.name, args);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: result,
              },
            ],
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `Tool execution failed: ${message}`,
          },
        };
      }
    }

    default: {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
    }
  }
}
