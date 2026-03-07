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
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });

  let payload: unknown = null;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = text.length > 0 ? text : null;
  }

  if (!response.ok) {
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
