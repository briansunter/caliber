// Match the maximum JSON-RPC frame accepted by the stdio MCP transport.
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

/** Enforce byte limits while reading, including unknown-length/chunked bodies. */
export async function readRequestJson(
  request: Request,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Invalid request body limit");
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return JSON.parse("") as unknown;

  const reader = request.body.getReader();
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const nextLength = length + value.byteLength;
      if (nextLength > maxBytes) {
        // Do not wait for a disconnected sender's cancellation to settle.
        void reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      if (nextLength > buffer.length) {
        // Geometric growth bounds both retained bytes and tiny-chunk overhead.
        const capacity = Math.min(maxBytes, Math.max(4096, nextLength, buffer.length * 2));
        const expanded = new Uint8Array(capacity);
        expanded.set(buffer.subarray(0, length));
        buffer = expanded;
      }
      buffer.set(value, length);
      length = nextLength;
    }
    return JSON.parse(new TextDecoder().decode(buffer.subarray(0, length))) as unknown;
  } finally {
    reader.releaseLock();
  }
}
