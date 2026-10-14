import type { ReactNode } from "react";

/** Services belong to the embedding product; UI code never installs a global fetch hook. */
export interface FrontendOptions {
  /** Absolute service base URL, including its API path and trailing slash. */
  apiBase: string;
  /** Product controls such as an execution-environment selector; navigation stays intact. */
  productControls?: ReactNode;
  /** Explain unavailable service integrations in place, without deleting their entries. */
  unavailableFeatures?: Partial<Record<FrontendFeature, string>>;
  /** The adapter returns responses matching the frontend contracts. */
  fetch?: typeof globalThis.fetch;
  /** Authentication headers, applied only to requests inside apiBase. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  productName?: string;
  storageNamespace?: string;
  /** Presentation bootstrap for products that do not run an OpenGrove Bridge. */
  bootstrap?: FrontendBootstrap | (() => Promise<FrontendBootstrap>);
  /** Optional product account login, rendered inside the original authentication page. */
  passwordLogin?: (credentials: { account: string; password: string }) => Promise<void>;
}

export interface FrontendBootstrap {
  environment: { preset: string };
  mcpApps: { sandboxOrigin?: string };
}

export interface FrontendHandle {
  /** Unmount UI, cancel queries, stop subscriptions and release the router. */
  dispose(): void;
}

let options: FrontendOptions | undefined;
let namespace: string | undefined;
let identity: string | undefined;

export function configureFrontend(value: FrontendOptions): void {
  const base = new URL(value.apiBase);
  if (!['http:', 'https:', 'opengrove-desktop:'].includes(base.protocol)) throw new Error('frontend_api_base_protocol_unsupported');
  if (base.username || base.password || base.search || base.hash) throw new Error('frontend_api_base_must_not_contain_credentials_query_or_fragment');
  base.pathname = base.pathname.replace(/\/?$/, '/');
  const nextNamespace = value.storageNamespace ?? 'agent-frontend';
  if (!/^[a-zA-Z0-9._-]+$/.test(nextNamespace)) throw new Error('frontend_storage_namespace_invalid');
  if (namespace && namespace !== nextNamespace) throw new Error('frontend_namespace_requires_new_document');
  const nextIdentity = JSON.stringify([base.href, nextNamespace, value.productName ?? 'OpenGrove']);
  if (identity && identity !== nextIdentity) throw new Error('frontend_identity_requires_new_document');
  namespace = nextNamespace;
  identity = nextIdentity;
  options = { ...value, apiBase: base.href, storageNamespace: nextNamespace };
}

export function frontendOptions(): FrontendOptions {
  if (!options) throw new Error('frontend_not_configured');
  return options;
}

export async function frontendFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const host = frontendOptions();
  const url = new URL(input instanceof Request ? input.url : String(input), host.apiBase);
  const base = new URL(host.apiBase);
  const serviceRequest = url.origin === base.origin &&
    (url.pathname === base.pathname.slice(0, -1) || url.pathname.startsWith(base.pathname));
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (serviceRequest && host.headers) {
    new Headers(await host.headers()).forEach((value, key) => headers.set(key, value));
  }
  return (host.fetch ?? globalThis.fetch.bind(globalThis))(input, { ...init, headers });
}

export type FrontendFeature = "app-store" | "app" | "extensions" |
  `settings.${"mode" | "kernels" | "ops" | "providers" | "apps" | "voice" | "network" | "desktop" | "updates" | "appearance"}`;
