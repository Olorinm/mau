# Agent Frontend

`@olorinm/agent-frontend` is the complete OpenGrove browser application extracted
into a separately installable package. It lives alongside the smaller
`@olorinm/agent-ui` component library; importing that library does not load this app.

## Mount in a product

Install the frontend archive, React 19 and React DOM 19. Build the consumer with
an ESM browser bundler such as Vite. Node 24 is used for package development.

```ts
import { mountFrontend } from '@olorinm/agent-frontend';
import '@olorinm/agent-frontend/style.css';

const frontend = await mountFrontend(document.getElementById('root')!, {
  apiBase: new URL('/frontend-api/', location.href).href,
  productName: 'Mau',
  storageNamespace: 'mau',
  // Optional product adapter: return real responses in the frontend wire format.
  // fetch: mauFrontendFetch,
  // headers: async () => ({ Authorization: `Bearer ${await sessionToken()}` }),
});

// When the product tears down this application:
frontend.dispose();
```

Use a full-page mount and an HTML viewport meta tag. The original application
owns the browser router, document language/theme and local UI state. Mount one
instance per document. A detached root or simultaneous mount is rejected.
Disposal unmounts React, disposes the router and releases query/theme listeners.
Changing API base, product name or storage namespace requires a new document;
existing stores and typed clients deliberately keep one identity. A remount with
the same identity is supported. Authentication callbacks can return renewed tokens.
A failed initial bootstrap rejects `mountFrontend`; the embedding product can
render an error and retry. Runtime render errors use the original error boundary.

`headers` is applied only to the configured API origin and path. Static media and
external links do not receive these authentication headers. Use same-origin
cookie authentication or signed resource URLs for images, frames and downloads:
DOM resource requests do not pass through the Fetch adapter. `fetch` receives the
original Request/body/signal and must preserve cancellation and streaming. The
package never overrides `window.fetch`.

`passwordLogin` optionally accepts `{ account, password }` and authenticates with
the embedding product. The existing login page then renders account/password
inputs with the original layout and styles. Resolve only after the real account
session exists; the frontend revalidates it through `/auth/session`. Reject with
a user-facing error on failure. Passwords stay in component state and are cleared
on success. Without this option, the original email/code login remains.

`productName` changes the app wordmark and translated product references. The
original sapling artwork, protocol identifiers, desktop bridge contract and
external source attribution remain. `storageNamespace` isolates local UI settings
and account cache from another product on the same origin.

## Pages and platform support

The package retains the original layout, navigation, responsive styles, themes,
translations and gates, including:

- Rooms, employees, profiles, conversations and direct kernel chat.
- Native run/session rendering, tools, approval and question interactions.
- File browsing, Markdown/code editing, previews and conflict comparison.
- Mounted Apps, App Store, app builder, MCP Apps and permissions.
- Skills, MCP, kernel plugins, hooks and other extension management.
- Account/onboarding and all settings sections: mode, kernels, appearance,
  desktop, updates, network, operations, providers, Apps and voice.
- Desktop startup/settings UI and its existing bridge hooks. A browser package
  does not install Electron or implement the native desktop bridge.

No additional product-specific entry hiding is introduced. Existing upstream
mode, authentication and platform policies still apply. Direct kernel chat keeps
its original setting rather than being removed as dead code.

Excluded by scope: the Chrome/Edge extension, unused knowledge-property editing
and last-library state, the unused standalone operations view/sidebar, and the
unreferenced Disclosure forwarding module. Markdown editing/preview and the
operations panel inside Settings remain.

## Service boundary

An independent UI does not imply identical backend APIs. The default transport
expects the original frontend contracts under `apiBase`; it works with an
OpenGrove Bridge. A product such as Mau supplies a Fetch adapter or implements a
product-owned HTTP facade. Router continues owning accounts/messages/routing,
Host owns native execution and approvals, and Environment owns execution
resources. None of those services are copied into this package.

The generated `@olorinm/agent-frontend/contracts.openapi.json` describes the typed
Host operations. The extracted `contracts/` source is the versioned reference for
that catalog. Legacy frontend query shapes are declared in `src/bridge-*-types.ts`
and their call sites in `src/bridge-client.ts` and `src/runtime/use-bridge-queries.ts`;
they are not all covered by the typed catalog yet. A consumer adapter must cover
these too. Missing operations must fail explicitly, never return fabricated
success, empty account data or invented native capability claims.

`bootstrap` can supply `{ environment: { preset }, mcpApps: { sandboxOrigin? } }`
for a product without an OpenGrove Bridge discovery endpoint. This is presentation
configuration, not an assertion about native execution capabilities. Otherwise
bootstrap is loaded through the original discovery contract. Embedded MCP Apps
still require the original sandbox and media routes and their security rules.

The HTML shell, build-version reload policy, global error logging, CSP, resource
proxying and deployment remain the embedding application's responsibilities.
The original desktop update UI and hooks are retained separately from the
OpenGrove website's `version.json` reload watcher.

## Develop and verify

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm run test:package
```

`test:browser` uses an explicitly empty local fixture, checks retained navigation,
settings, branding, dark/mobile rendering, the original auth gate and disposal.
It does not claim live model/cloud acceptance. `test:package` installs the actual
archive in a fresh temporary project, checks exported types, builds with that
project's dependencies and runs the same browser acceptance against its output.
No source aliases or sibling repository access are used by that consumer.

To inspect the standalone consumer against a real local Bridge:

```sh
FRONTEND_BACKEND_URL=http://127.0.0.1:37371 npm run dev
```

`examples/mau` demonstrates the public mounting API and brand setting. It is an
integration preview, not a completed mapping of Mau's product APIs. The example
proxies to the configured local service and contains no fake production backend.

## Provenance

See `source-manifest.json` for the upstream commit and original source hashes,
and `NOTICE` for attribution. Source-presence tests keep every upstream page
except the approved exclusions; stylesheet hashes and navigation catalogs are
checked against the recorded source. The browser-safe shared utilities and
protocol/client bindings are internal copies from that same revision, so building
this package never reaches into the OpenGrove checkout.
