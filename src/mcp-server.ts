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
  const maxFrameBytes = 1024 * 1024;
  let pending = "";

  const stdin = Bun.stdin.stream();
  const reader = stdin.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    pending += decoder.decode(value, { stream: true });
    if (new TextEncoder().encode(pending).byteLength > maxFrameBytes) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request frame is too large" },
        })}\n`,
      );
      pending = "";
      continue;
    }

    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
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

  pending += decoder.decode();
  if (pending.trim()) {
    try {
      const request = JSON.parse(pending) as MCPRequest;
      const response = await handleJSONRPC(request);
      if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${message}` },
        })}\n`,
      );
    }
  }
}

main().catch((error) => {
  console.error("MCP Server error:", error);
  process.exit(1);
});
