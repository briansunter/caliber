/**
 * MCP (Model Context Protocol) Server Integration
 * Provides local library search tools for book titles and authors
 */

import {
  searchBooksByTitle,
  searchBooksByAuthor,
  getAuthorByName,
  searchBooksCursor,
  type BookListItem,
} from "./lib/calibre-optimized";

// MCP Protocol types
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// MCP Server capabilities
const serverCapabilities = {
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

// Available tools
const tools: MCPTool[] = [
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

// Format book for display
function formatBook(book: BookListItem): string {
  const parts = [
    `"${book.title}"`,
    book.authors.length > 0 ? `by ${book.authors.join(", ")}` : "",
    book.series ? `(Book ${book.series_index} in ${book.series})` : "",
    book.formats.length > 0 ? `[${book.formats.join(", ")}]` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * Execute a tool call
 */
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "search_book_title": {
      const title = args.title as string;
      const count = Math.min((args.count as number) || 10, 20);

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
      const author = args.author as string;
      const count = Math.min((args.count as number) || 10, 20);

      // First get author info
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
        for (let i = 0; i < books.length; i++) {
          output += `${i + 1}. "${books[i]?.title}"`;
          if (books[i]?.series) {
            output += ` (Book ${books[i]?.series_index} in ${books[i]?.series})`;
          }
          output += ` [${books[i]?.formats.join(", ")}]
`;
        }
      }

      return output;
    }

    case "search_library": {
      const query = args.query as string;
      const limit = Math.min((args.count as number) || 10, 20);

      const result = searchBooksCursor({ query, limit });

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

/**
 * Handle MCP JSON-RPC requests
 */
async function handleJSONRPC(request: MCPRequest): Promise<MCPResponse> {
  switch (request.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: serverCapabilities,
      };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools,
        },
      };
    }

    case "tools/call": {
      const params = request.params as {
        name: string;
        arguments?: Record<string, unknown>;
      };

      try {
        const result = await executeTool(params.name, params.arguments || {});

        return {
          jsonrpc: "2.0",
          id: request.id,
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
          id: request.id,
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
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
    }
  }
}

/**
 * Main MCP request handler
 */
export async function handleMCPRequest(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // Only accept POST requests
  if (req.method !== "POST") {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "Invalid request method. Use POST.",
        },
      },
      { status: 405 },
    );
  }

  try {
    const body = await req.json();

    // Handle batch requests
    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((req) => handleJSONRPC(req as MCPRequest)));
      return Response.json(responses, {
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Handle single request
    const response = await handleJSONRPC(body as MCPRequest);
    return Response.json(response, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: `Parse error: ${message}`,
        },
      },
      {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}
