interface ErrorPayload {
  error?: string;
  message?: string;
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return typeof value === "object" && value !== null;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function fetchJson<T>(input: string | URL, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const response = await fetch(input, {
    // Query keys isolate users/libraries, but the browser cache keys only on
    // the URL. Revalidate JSON so a fresh response from a previous library or
    // session cannot bypass the server. ETags still avoid unchanged bodies.
    cache: "no-cache",
    ...init,
    headers,
  });

  let payload: unknown = null;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch (error) {
      // A proxy or interrupted error response may claim JSON without sending
      // valid JSON. Preserve its HTTP status so auth recovery and retry rules
      // still work. Successful responses must satisfy their declared format.
      if (response.ok || !(error instanceof SyntaxError)) throw error;
    }
  } else {
    const text = await response.text();
    payload = text.length > 0 ? text : null;
  }

  if (!response.ok) {
    // Let the app re-check auth state (and show the login screen) when a
    // session expires mid-use.
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("caliber:unauthorized"));
    }

    const message =
      isErrorPayload(payload) && typeof payload.error === "string"
        ? payload.error
        : isErrorPayload(payload) && typeof payload.message === "string"
          ? payload.message
          : `Request failed with status ${response.status}`;

    throw new HttpError(message, response.status, response.statusText, payload);
  }

  return payload as T;
}
