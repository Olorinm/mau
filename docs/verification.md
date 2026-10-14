# Verification

Run `npm run typecheck`, `npm test` and `npm run build` after bootstrap.
Lifecycle regressions cover owner isolation, concurrent allocation, private
bootstrap files, lost responses, unknown execution guards, pause/resume,
missing environments, renewal failures and coordinator leases.

The independent consumer installs Mau, Router, Environment and Host archives in
a temporary directory and runs the real Mau CLI and Host service:

```sh
npm run verify:packages -- --environment-archive .packages/agent-environment.tgz \
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

Validated for this branch: 10 Mau lifecycle/bootstrap tests and the independent four-archive
consumer above. The shared package additionally passes the original 119 OMA
sandbox tests, 21 provider/CLI tests and a fresh install with scripts disabled,
including original bytes, split UTF-8, BOM and public TypeScript declarations.
The OMA consumer branch passes Pi, Session Router and relevant API tests.
The new shared package is local/unpublished; public CI and release require an
authorized distributable archive in `components.json` first.
