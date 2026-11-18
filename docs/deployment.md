# Deployment on Cloudflare

Mau is deployed as one Worker with one container. [`cloudflare/`](../cloudflare) holds the Worker and the
container's start script; the [Dockerfile](../Dockerfile) builds the image.

```text
browser, CLI ──▶ Cloudflare Access ──▶ Worker ──▶ Durable Object ──▶ container (mau-server, port 8790)
                                                    │                    │ restores at start, copies while running
                                                    └─ access records ─▶ R2 ◀─ state, configuration
```

- The **Worker** passes every request to one Durable Object.
- The **Durable Object** keeps the container running, forwards requests and WebSockets to it, adds transport
  security headers, keeps an access record of each request and starts the daily backup.
- The **container** has an empty disk at every start. Its start script reads the configuration bucket into
  `/config`, restores `/state` from the state bucket, then runs Mau and keeps copying `/state` back.

A container can be stopped by the platform at any time and started again on another machine. Mau therefore
behaves as after a process restart: runs that were in progress are reconciled, channels reconnect.

## State and what a stop can lose

| What | Copied by | To | When |
| --- | --- | --- | --- |
| SQLite databases below `/state` (also ones created while running) | [Litestream](https://litestream.io) | `db/<path>` in the state bucket | As they change, within about a second |
| Every other file below `/state` | [rclone](https://rclone.org) | `files/` in the state bucket | Every 30 seconds, and once after Mau has stopped |

A stop that Mau is asked for (a deploy, `RUN` set to another value, the platform's `SIGTERM`) loses nothing that
was committed: Mau has 30 seconds to close, then Litestream sends what is left, the files are copied once more,
and only then does the container exit. A container that is killed can lose the last second of database writes,
a database created in its last two seconds, and the last 30 seconds of file changes.

A start refuses to run Mau when the restore fails, and, once this deployment has served requests, when it finds no
database to restore. A broken or emptied bucket therefore stops the deployment instead of being overwritten by a
new empty state. To start over on purpose, deploy under a new Worker name with empty buckets.

`/state/router/tmp` (uploads in progress) is not copied. Attachments are not in `/state`: configure Router's
blob store for R2 in `mau.env`.

## Buckets and credentials

Create three private R2 buckets: configuration, state, and access records. Create one R2 API token with
*Object Read & Write* on the configuration and state buckets only; its access key pair becomes the Worker's
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets and reaches the container as environment variables. The
access-record bucket is written through the Worker's binding and needs no key.

The **configuration bucket** is copied to `/config` as it is. It contains:

| Object | Purpose |
| --- | --- |
| `mau.env` | Environment of `mau-server` that differs per deployment (below) |
| `mau.json` | Mau's configuration ([environments](environments.md)); paths in it are below `/config` |
| anything `mau.env` or `mau.json` refers to | Edge identity, Environment `providers.json` and key files, Host profiles, private profile files, connector keys |
| `backup.json` | Optional: configuration of the daily backup (below) |

```sh
# mau.env
MATRIX_SERVER_NAME=agents.example            # the owner-ID namespace; no Matrix server is used
AGENT_SERVICE_URL=https://mau.example/_agent-router/v1
AGENT_EDGE_IDENTITY_FILE=/config/edge-identity.json   # unless mau.json holds edgeIdentity
AGENT_TRUST_PROXY=…                          # the address requests arrive from inside the container
```

The image sets `HOST`, `PORT`, `MAU_STATE=/state`, `AGENT_SERVICE_STATE=/state/router`,
`MAU_CONFIG_FILE=/config/mau.json`, `MAU_WEB_ROOT` and the Google Workspace CLI path. Configuration is read at
start: after changing the bucket, change `CONFIG_REVISION` in the Wrangler configuration and deploy; the
container restarts as for a new image.

## Deploy

Requires Workers Paid, Node.js 24+, a Docker-compatible engine for the image build, and the Agent Kit archives
(`node scripts/bootstrap.mjs`).

1. Put the hostname behind Cloudflare Access ([web console](web.md#login-cloudflare-access)); leave
   `/health/live` reachable without login if something outside checks it.
2. Copy [`wrangler.example.jsonc`](../cloudflare/wrangler.example.jsonc) to a private location and fill in the
   hostname, bucket names and the R2 endpoint.
3. In `cloudflare/`: `npm ci`, `npm run check`, `npm test`, then
   `npx wrangler deploy --config /private/mau.wrangler.jsonc`. Wrangler builds and pushes the image.
4. `npx wrangler secret put R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` with the same `--config`.
5. Give the access-record bucket a lifecycle rule that deletes objects after the retention you want.

A later deploy with a changed image or `CONFIG_REVISION` stops the running container as described above and
starts the new one; a deploy that changes only the Worker leaves the container running. A container that exits
on its own is started again within seconds. Requests during a restart get `503` with `Retry-After`.

`RUN` in the Wrangler configuration is the switch: any value but `"true"` stops Mau and keeps it stopped. Use it
before working on the buckets directly.

## Moving state in

To bring in the state of an installation that ran elsewhere, or the `/state` of a backup archive, stop Mau, empty
the state bucket, and run the image once with that directory mounted at `/state`:

```sh
docker run --rm -v /path/to/state:/state \
  -e R2_ENDPOINT -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY -e CONFIG_BUCKET -e STATE_BUCKET \
  <image> seed
```

It copies the state to the bucket as a run would have left it and starts nothing; it refuses a bucket that is not
empty. The directory must be writable by uid 1000: Litestream switches each database to WAL and adds its two
bookkeeping tables. The next start of the deployment restores from the bucket.

The instance size (1 vCPU, 768 MiB, 4 GB disk) is set in [`src/index.ts`](../cloudflare/src/index.ts).

## Access records

Each request leaves one JSON line: time, method, path without the query, status, duration and client address.
No header, query or body is kept. Lines are written to the access-record bucket in batches as
`<date>/<time>-<sequence>.jsonl`, at the latest ten minutes after the request.

## Daily backup

With `BACKUP_HOUR_UTC` set, the Durable Object runs Agent Environment's
[`server-backup.py`](https://github.com/Olorinm/agent-kit/tree/main/packages/environment/cloudflare#managed-secrets-network-restrictions-and-independent-backups)
in the container once a day with `/config/backup.json`: an age-encrypted archive of `/state` and `/config`,
uploaded to the backup ingress. `paths` in that file are `["/state", "/config"]`. A failed run is logged as
`mau_upkeep_failed` and tried again an hour later. The copies in the state bucket protect against losing the
container; the backup protects against losing or damaging the bucket.

## Limits

- `mau ssh` needs an HTTP upgrade other than WebSocket, which a Worker does not forward.
- One deployment is one container. Do not point two deployments at the same state bucket.
