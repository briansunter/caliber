#!/usr/bin/env bun
/**
 * MCP Server for Caliber - Stdio Transport
 * Standalone MCP server that connects directly to the Calibre database.
 */

import { initFTS } from "./lib/calibre-optimized";
import { handleJSONRPC, type MCPRequest } from "./lib/mcp-core";

initFTS();

async function main() {
  const decoder = new TextDecoder();

  const stdin = Bun.stdin.stream();
  const reader = stdin.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    const lines = text.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const request = JSON.parse(line) as MCPRequest;
        const response = await handleJSONRPC(request);
        if (response !== null) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorResponse = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${message}`,
          },
        };
        process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
      }
    }
  }
}

main().catch((error) => {
  console.error("MCP Server error:", error);
  process.exit(1);
});
