# Verification

Run `npm run typecheck`, `npm test` and `npm run build` after bootstrap. `npm run test:web`
builds the [web console](web.md) and adds its connection-layer and browser tests.
Lifecycle regressions cover owner isolation, concurrent allocation, private
bootstrap files, lost responses, unknown execution guards, pause/resume,
missing environments, renewal failures and coordinator leases.

The independent consumer installs Mau, Router, Environment and Host archives in
a temporary directory and runs the real Mau CLI and Host service:

```sh
npm run verify:packages -- --environment-archive .packages/agent-environment.tar \
  --host-archive /path/agent-host.tgz \
  --host-fixture /path/agent-host/test/fixtures/codex-server.mjs
```

Router defaults to `.packages/agent-router.tgz` (override with `--router-archive`).
The check verifies setup, channel connection, worker reply, application/Host
restart, original native session continuation and destruction. It imports only
public packages, never sibling source or private implementation paths.

Cloud lifecycle and Codex protocol are fixtures. File operations, package
installation, CLI, HTTP Host process, delivery worker and durable restart are real
local operations. Earlier live acceptance belongs to the pre-split integration;
it does not prove this Mau package is deployed. This change does not modify live
resources or user accounts. Cloud storage and real model/channel access need
separate deployment-specific acceptance.

The OMA extraction keeps the original sandbox implementation, native filesystem,
workspace attestation and command-byte patch in Agent Environment. Mau consumes
its public provider types and uses `/sdk` in its transport fixture, so exception
class identity and byte callbacks match the installed shared runtime. Mau keeps
its persistent Host coordination; OMA's per-Turn policy is not imposed on it.

Validated for this branch: 16 Mau lifecycle/bootstrap tests and the independent four-archive
consumer above. The shared package additionally passes the original 119 OMA
sandbox tests, 21 provider/CLI tests and a fresh install with scripts disabled,
including original bytes, split UTF-8, BOM and public TypeScript declarations.
The OMA consumer branch passes Pi, Session Router and relevant API tests.
CI reads the pinned private Environment source with a repository-scoped read-only
deploy key (`ENVIRONMENT_READ_KEY`), rebuilds the uncompressed release archive and
checks its exact lockfile integrity before installation. It does not upload or
cache the private package. Fork CI requires an operator-authorized run with access.
The public Mau archive contains no Environment implementation or deployment state.

## Shared workspaces — 2026-10-14

Mau 0.1.0-alpha.4 with Environment 0.2.0-alpha.2 was deployed and checked against
real Volcengine VKE/VCI and TOS. The authenticated product API created an owned
workspace and two Agents using the same workspace. API-uploaded binary bytes
with Unicode/percent-literal filenames were visible in both containers. A write
from one container was read by the other and returned through the product's
file list and signed download APIs.

Product pause/resume reused the original environment ID, reverified the mount,
and preserved both private container state and shared bytes. Destroying both
environments left the workspace downloadable. The temporary environments were
removed. Existing environment profiles and bindings remained ready. This
acceptance exercised actual Host bootstrap/readiness and storage; it did not run
an additional LLM turn. Raw reports, credentials and production IDs remain in
private operational state.

Local validation passed the 21 Mau tests, independent CLI installation and the
four-package Mau/Router/Environment/Host consumer. Environment separately passed
119 original OMA tests and 35 provider/workspace checks. See
[shared workspaces](workspaces.md) for configuration and API semantics.

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
Shared workspaces remain available through the existing API and CLI.

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
