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
  timeoutMs?: number;
} = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  // Matrix sync holds a request for 25 seconds. Bound the whole response, including its body.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? 35_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    const response = await fetch(url, {
      method,
      credentials: "omit",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal,
    });
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
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (deadline.signal.aborted) throw new ApiError("request_timeout", 0);
    if (error instanceof ApiError) throw error;
    throw new ApiError("network_error", 0);
  } finally { clearTimeout(timer); }
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
