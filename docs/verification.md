# Verification

## Hermes-style memory and unified tasks — 2026-10-29

Final local verification: **151 tests in 24 files**, type checking, server/web
builds and independent-package installation/acceptance pass on Node.js 24.22.2.

The subsequent local change replaces keyword-ranked facts with bounded memory
files and frozen native instructions. Tests cover actual cross-process file
writes, UTF-8/Unicode capacity, atomic edits, stale approvals, hostile-content
screening, scope isolation, old-fact preservation, native fork/restart behavior,
and original-text SQLite retrieval. Completion bookkeeping resolves public
Router session IDs asynchronously and never waits for a review model in the
owner's foreground turn.

Unified-task tests cover direct reminders without Host calls, trusted connector
prechecks, unchanged/failure/unknown outcomes, checkpoint commit timing, fresh
and reused sessions, idle conversation execution, real Heartbeat defaults,
legacy-rule preservation and cancellation races. The independent package
consumer additionally verifies fixed-message provider acceptance with no extra
native Agent call. These provider/cloud/model behaviors use deterministic
fixtures, not live external accounts.

The review isolation probe uses the actual Codex 0.165.0 executable with an
isolated home and a local simulated Responses endpoint. Its configured model
catalog is gpt-5.4. Only the designated dynamic memory tool is advertised;
forced non-whitelisted calls are rejected. No external model, personal account
or production employee is used. This establishes the tested version/profile
boundary, not general future Codex tool isolation or live learning quality.

See [memory behavior and deployment boundaries](hermes-memory.md) and the
[pinned source audit](hermes-memory-source.md). A dedicated restricted worker
and original-employee managed-tool mapping must be configured before automatic
background review can run. The default product reports this as unsupported.

Run `npm run typecheck`, `npm test` and `npm run build` after bootstrap. `npm run test:web`
builds the [web console](web.md) and adds its connection-layer and browser tests.
Lifecycle regressions cover owner isolation, concurrent allocation, private
bootstrap files, lost responses, unknown execution guards, pause/resume,
missing environments, renewal failures and coordinator leases.

The independent consumer installs Mau and the pinned Router, Host, Connectors and Environment
archives in a temporary directory and runs the real Mau CLI and Host service:

```sh
npm run verify:packages
```

It uses the archives and Host's protocol fixture that bootstrap downloaded into `.packages/`.
The check verifies setup, channel connection, worker reply, application/Host
restart, original native session continuation and destruction. It imports only
public packages, never sibling source or private implementation paths.

Cloud lifecycle and Codex protocol are fixtures. File operations, package
installation, CLI, HTTP Host process, delivery worker and durable restart are real
local operations. Earlier live acceptance belongs to the pre-split integration;
it does not prove this Mau package is deployed. This change does not modify live
resources or user accounts. Cloud storage and real model/channel access need
separate deployment-specific acceptance.

The environment provider in this check is a local fixture that implements Agent Environment's
public `EnvironmentProvider` interface. The public Mau archive contains no Environment
implementation or deployment state.

## Native work integration — 2026-10-29

The earlier native-work checkpoint passed 102 Mau tests in 17 files, including browser
fixtures and the unchanged HTTP security probe, on Node.js 24.22.2. A fresh
`npm ci --ignore-scripts` from the pinned local Router archive, type checking,
server build and web build also pass. The HTTP probe reports bundled Undici
7.30.1, npm Undici 8.12.3, body-parser 2.4.0 and qs 6.17.1. It also passed on
Node.js 26.13.0; older tested Node.js 24.21.0 failed the built-in fetch probe.
Docker and CI retain the verified 24.22.2 baseline.

The independent five-package consumer passes the original setup, restart and
resume checks plus owner tool calls that create and wait for delegated work,
fork with narrower run grants, native skills/memory discovery, per-turn facts,
and a persisted scheduled trigger. The scheduled work remains queued during an
explicit owner pause; after explicit resume, it executes through native
`toolOutput` and obtains Router's provider-acceptance receipt. Repeating the
trigger does not send another notification. Automatic idle sleep/wakeup and
the rule that owner pause blocks automatic wakeup have separate lifecycle
regressions. The package fixture does not simulate user pause as idle sleep.

```sh
node scripts/bootstrap.mjs
npm run build
npm run build:web
MAU_WEB_E2E=1 npm test
npm run verify:packages
```

These are local package, protocol and provider fixtures. This change does not
deploy Mau, authorize accounts, read real Gmail, or send real channel messages.
Mau has no current connector-backed cursor proof adapter: model cursor proposals
are recorded as unverified and cannot advance source cursors. The native memory
management endpoints retain actual runtime errors; enabling the management
allowlist does not enable native memory generation.

## Initial frontend isolation and source comparison (2026-10-15)

The initial frontend integration used Agent UI and Agent Frontend `0.1.0-alpha.3`
release archives. The lockfile, `components.json` and actual archive SHA-512 values match.
Product-owned theme state updates the component provider and its portals together.
Creating an app opens the extracted original dialog over the active page; closing
it returns focus to the opener. Unsupported services remain explicitly unavailable.
Provider, operations and voice settings use the original presentation components.

The local build and all 38 tests passed, including the new unavailable-create and
focus assertions. Direct original-source screenshots of light/dark appearance and
theme menus matched at desktop and mobile sizes (6 captures, zero differing pixels).
Full-page captures are review-only because product data and branding differ. The
reusable comparison runner and broader component coverage live in agent-ui's
`frontend/` directory. These checks use isolated fixtures, not a live Agent or a
production deployment.


## Frontend merge review (2026-10-15)

The final consumer pins Agent UI and Agent Frontend `0.1.0-alpha.4` release
archives from merge revision `94f7e64bf39f96a35e6644fd33937cf2150595d7`.
Their downloaded SHA-512 values and MIT metadata match the lockfile and component
pins; other dependencies and Mau’s `0.1.0-alpha.6` version are unchanged.

The review retains the existing Mau API, account authorization, Environment
lifecycle and Feishu recovery paths. The new assembled Files screen is omitted;
its navigation entry explicitly reports that file browsing is not connected.

Opening a direct conversation now waits for the first Matrix room inventory.
Concurrent initial reads share one request; a failed sync does not create a room,
and retry can complete normally. Regression tests cover a delayed existing room
and a failed first inventory. Sending still retains Matrix transaction IDs.

Local acceptance passed all 42 tests, including browser checks for theme-scoped
menus and original app dialogs, cancel focus restoration, mobile Tab/Escape
behavior, the keyboard-accessible unavailable Files entry and Feishu recovery.
Chinese and English dialogs at 390px and 320px have no horizontal overflow
inside the dialog, form groups or action row; each action button is fully visible.
These checks use the separately downloaded immutable UI archives and fixture
services; they do not claim live Matrix, native-model or deployment acceptance.

## Original frontend restoration (2026-10-16)

Mau alpha.7 pins Agent UI alpha.6 and Agent Frontend alpha.5 as immutable archives.
The original `RunMessage` renders in the message body instead of nesting process,
status and answer in a reply bubble. Host's public adapters preserve native
choices, question replies and tool input/output. History publishes each page and
drains terminal events; the product build watcher preserves active work.

All 47 Mau tests pass with built production assets and web acceptance enabled.
The browser fixture checks streaming text, open tool details, refresh-restored
approval, exact allow/deny/question replies, stop and post-stop history. Reader
and watcher tests cover page/end races and reload guards. Independent CLI install
and recovery checks pass. Agent Frontend separately audits 115 original component
files and verifies the restored presentation; its audit ledger distinguishes
source mapping, visual comparisons, callback checks and product availability.


Live acceptance exposed a remount when a final Matrix reply enabled copying.
Mau alpha.8 pins Frontend alpha.6, whose stable context-menu boundary retains the
message body. The integration regression now starts a second run without an early
text reply, opens its process, completes it and waits for final Matrix delivery;
it asserts both the same DOM node and an expanded disclosure. The test fails with
the previous package and passes with alpha.6. All 47 tests pass with the new archive.
