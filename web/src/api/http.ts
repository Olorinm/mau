/** A stable error code from Mau, Router or Matrix. Messages are never shown raw. */
export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const code = /^[A-Za-z0-9_]+$/;

export async function request<T>(url: string, options: {
  token?: string;
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "omit",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError("network_error", 0);
  }
  if (response.status === 204) return null as T;
  // Rate limiters and proxies may answer with text rather than JSON.
  const data = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) {
    // Matrix pairs a stable errcode with a human message in error; Mau and Router send only error codes.
    const reported = data?.errcode ?? data?.error;
    throw new ApiError(
      typeof reported === "string" && code.test(reported) ? reported
        : response.status === 429 ? "rate_limited" : "request_failed",
      response.status,
    );
  }
  if (data === undefined) throw new ApiError("invalid_response", response.status);
  return data as T;
}

/** Only https links are rendered as QR codes or opened. */
export function safeExternalUrl(raw: string | undefined): string | undefined {
  if (!raw || /[\x00-\x1f\x7f-\x9f]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
