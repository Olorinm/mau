# Environment setup

[简体中文](environments.zh-CN.md)

Mau owns environment profiles, provisioning, the operation journal, Host bootstrap,
Agent/environment binding, lifetime renewal and idle pause/wake. Router owns account identity,
channel authorization and delivery. Host owns native execution and sessions.

## Configure the server

1. Prepare a Matrix Application Service identity using [Router deployment](https://github.com/Olorinm/agent-router/blob/main/docs/guides/managed-agents.md). Mau embeds Router; run only one consumer of that identity and its channels.
2. Prepare an existing sandbox service and template using [Environment](https://github.com/Olorinm/agent-environment). Mau allocates sandboxes, not clusters or networks.
3. Install Host and the native kernel in the template. Start Host with `serve --ready-file ...`; preserve Host state, native sessions and workspace on durable paths.
4. Copy [mau.json](../examples/mau.json) and [Host config](../examples/cloud/host-profile.json) outside the repository. Supply private Environment `providers.json` and API-key files. Paths resolve relative to `mau.json`; adjust them when moving files.
The optional `publicHomeserver` in Mau configuration is the public Matrix login
origin (defaults to `https://MATRIX_SERVER_NAME`). It must be reachable by users;
the private `MATRIX_HOMESERVER_URL` is never returned to clients.

5. Assign profiles to exact Router owner IDs (`owners: ["*"]` explicitly permits all accounts). Private `files` inject individual native credentials, never into a shared image. Clients select only profile IDs; they cannot submit commands, URLs or file paths.
6. Optional `connectionsFile` points to Router's private JSON containing `mailServices`. All channel connection logic stays in Router.

```sh
MATRIX_SERVER_NAME=agents.example
MATRIX_HOMESERVER_URL=https://matrix.example
AGENT_SERVICE_URL=https://mau.example/_agent-router/v1
MATRIX_AS_TOKEN_FILE=/private/as-token
MATRIX_HS_TOKEN_FILE=/private/hs-token
MAU_CONFIG_FILE=/private/mau.json
MAU_STATE=/data/mau
HOST=0.0.0.0
PORT=8790
```

Start `mau-server`. Route `/_mau/v1`, `/_agent-router/v1` and Matrix Application
Service `/_matrix/app/v1` to it. Only explicitly trusted proxy addresses belong in
`AGENT_TRUST_PROXY`. Router external identity options are also available through
`loadServiceConfig`. [Dockerfile](../Dockerfile) provides a generic image; run
bootstrap first, mount private config read-only and writable state separately.

`MAU_STATE/router/` contains identities, channels and delivery records.
`MAU_STATE/mau/` contains the environment journal and per-Agent Host tokens.
Back up both plus native runtime/workspace data. One coordinator holds a renewable
journal lease. No production addresses, environment IDs, credentials or topology
belong in this repository.

## Lifecycle

Creation records the operation before requesting resources, then saves the returned
ID before bootstrap. Duplicate requests return the existing operation. A lost
response is reconciled by ID or unique metadata, never a blind second allocation.
Interrupted mutations become `needs_action` after restart.

Pause/destroy stop delivery workers and refuse active or uncertain runs before
changing cloud state. Resume retains the environment and native session binding.
Missing environments are never silently replaced. Provider-retained snapshots
may require separate cleanup.

Ready environments renew every 30 seconds. `lifetimeSeconds` must be at least 600.
A renewal request may fail twice; the third consecutive failure, or a confirmed
stopped environment, becomes `needs_action`. Cloud timeout policy applies during
longer Mau outages. Volcengine currently uses explicit pause and `kill` on expiry;
choose durable storage accordingly.

Optional `idlePauseSeconds` (600 to 2592000) pauses a ready environment after no
Host requests for that long, using the same guarded pause. The state is `sleeping`.
Router keeps receiving messages; when deliverable work waits, it asks Mau to wake
the environment, and the first reply waits for resume. Active or unresolved runs
count as activity. An explicit `mau pause` is never woken by messages.

Provider, template, kernel, runtime ID, Host directory and port identify an
existing binding and must not change. Labels, owners, instructions, lifetime, idle
and bootstrap file settings may change.

Host requests use Environment's application endpoint/traffic token and a separate
per-Agent Host token. Cloud management credentials stay in Mau. Private gateways
must preserve application Authorization and required sandbox routing headers.

```sh
mau setup helper --environment cloud-codex
mau channel-connect matrix
mau check
mau status
mau pause
mau resume
mau reconcile
mau destroy
```

`environment-create PROFILE` binds a selected unbound Agent. `agents` and `use NAME`
select existing identities. `--no-wait` returns progress; closing the terminal does
not cancel provisioning. `check` verifies configuration and HTTP/runtime access,
not real model authentication. Router's former product commands and provisioning
routes are deleted, with no compatibility aliases or automatic state migration.


## SSH access

Add `"ssh": { "port": 37421 }` to an assigned environment profile to enable
`mau ssh NAME`. Choose a port different from the Host service port. The environment
image must contain Node.js, OpenSSH server/client and `/run/sshd`; see
[Dockerfile.ssh](../examples/cloud/Dockerfile.ssh). Host keys are generated per
environment and must not be shared in an image.

Mau uses Environment's existing exec, file and application-endpoint interfaces;
OMA and Host are unchanged. It starts OpenSSH as the existing execution user.
Both setup and connection check account ownership. The CLI generates a temporary
Ed25519 identity, checks the Host key returned over the authenticated API, and
carries native SSH over an HTTPS `Upgrade: mau-ssh` tunnel. Front proxies and
provider application gateways must preserve HTTP Upgrade. No public per-container
SSH port is required. Custom HTTP entrypoints must call `mau.attach(server)`.

Each Agent allows up to eight connections or setup requests. Active SSH sessions
block lifecycle changes and idle pause while normal environment renewal continues.
Resume a paused environment before connecting. Client authentication expires after
ten minutes and established sessions after eight hours. Shell access exposes the
execution user's existing files and credentials; it does not change the existing
network or model-credential policy.

See [shared workspaces](workspaces.md).
