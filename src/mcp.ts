/**
 * MCP (Model Context Protocol) Server Integration
 * HTTP transport — delegates to shared mcp-core for protocol logic.
 */

import { handleJSONRPC, type MCPRequest } from "./lib/mcp-core";
import { readRequestJson, RequestBodyTooLargeError } from "./lib/request-body";

export async function handleMCPRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

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
    const body = await readRequestJson(req);

    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map((mcpRequest) => handleJSONRPC(mcpRequest as MCPRequest)),
      );
      const filtered = responses.filter((r) => r !== null);
      if (filtered.length === 0) {
        return new Response(null, { status: 202 });
      }
      return Response.json(filtered);
    }

    const response = await handleJSONRPC(body as MCPRequest);
    if (response === null) {
      return new Response(null, { status: 202 });
    }
    return Response.json(response);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32600, message: error.message } },
        { status: 413 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);

    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: `Parse error: ${message}`,
        },
      },
      { status: 400 },
    );
  }
}
