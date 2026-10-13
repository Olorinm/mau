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
