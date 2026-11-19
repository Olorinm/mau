# Deployment on Cloudflare

Mau runs in your own Cloudflare account: one Worker with one container for Mau, a second Worker (the
environment gateway of [Agent Kit](https://github.com/Olorinm/agent-kit/tree/main/packages/environment/cloudflare))
that gives each partner a sandbox, R2 buckets for configuration and state, and Cloudflare Access as the only login.
One command makes all of it and is the same command that continues, repairs and upgrades it.

## Deploy your own

You need:

- a Cloudflare account on the Workers Paid plan (containers need it), with R2 enabled and a Zero Trust
  organization (the Free plan is enough);
- a domain in that account, for the hostname Mau is served at;
- on this machine: Node.js 24, git, a running Docker engine (the image is built here), and a Codex sign-in
  (`codex login`, which writes `~/.codex/auth.json`; partners use it for their model).

```sh
git clone https://github.com/Olorinm/mau && cd mau
node scripts/bootstrap.mjs && npm run build
export CLOUDFLARE_API_TOKEN=...            # see "API token"; without it the local `wrangler login` is used
node dist/cli.js deploy --hostname mau.example.com --owner-email you@example.com
```

`mau deploy` prints one JSON line per step on stderr (`{"step", "status": "done" | "skipped" | "needs_owner" |
"failed", "detail"}`) and one JSON document on stdout: the resources, the URL, and `next`, the commands to run
next. Its exit code is 0 when the deployment is complete and answers, 2 when a human has to do something first
(`needsOwner` lists what, `next` is the command that continues), and 1 when a step failed (`detail.fix` says
what to do). `--dry-run` prints the same document for what a run would change and changes nothing.

Run the same command again after a failure, after doing what it asked for, and after `git pull` to upgrade:
every step looks at what exists at Cloudflare and makes only what is missing. `--hostname` and `--owner-email`
are needed the first time only. `--name` (default `mau`) is the prefix of every resource; a second deployment
in the same account takes another name. Deploy refuses a name under which the account already has a Worker or
a bucket that it did not make.

| Step | What it makes |
| --- | --- |
| `preflight` | Nothing. Checks Node.js, the checkout, the pinned archives, Docker, the credentials, that the hostname's zone is in the account and that the hostname is free. |
| `codex-auth` | A copy of the Codex sign-in in the deployment's configuration. |
| `buckets` | `NAME-config`, `NAME-state`, `NAME-attachments`, `NAME-access-logs` (objects deleted after 30 days), `NAME-environment-backups`. |
| `r2-credentials` | An account API token `NAME-container-r2` limited to object read and write on the first three buckets; its S3 key pair is what the container uses. |
| `gateway` | The Worker `NAME-environment` on the account's workers.dev subdomain, from the gateway source in the pinned Agent Kit archive, with its two secrets and the `age` program its sandbox backups need. |
| `access` | An Access application for the hostname that admits the owner's email only, and one for `/health/live` with a Bypass policy. |
| `config` | The configuration (below), uploaded to `NAME-config`; only changed objects are written. |
| `deploy` | The Worker `NAME` on the hostname, with the image built from this checkout. |
| `verify` | Nothing. Waits until `/health/live` answers and checks that `/` is redirected to Access. |

When it is done:

```sh
cloudflared access login https://mau.example.com
mau login https://mau.example.com
mau partner create NAME --profile codex
mau chat send NAME "hello"
```

### API token

With a token that has the permissions below, deploy does everything itself. Create it in the dashboard as an
account API token, or as a user token limited to the account and the zone. Where the dashboard does not offer a
permission, leave it out: deploy then asks you for that one step.

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Both Workers, their secrets and settings |
| Account | Containers: Edit | The container image and application |
| Account | Workers R2 Storage: Edit | The buckets and the lifecycle rule |
| Account | Access: Apps and Policies: Edit | The two Access applications |
| Account | Access: Organizations, Identity Providers, and Groups: Read | The team domain |
| Account | Account API Tokens: Edit | The container's R2 key pair |
| Account | Account Settings: Read | Wrangler |
| Zone | Zone: Read, Workers Routes: Edit, DNS: Read | The hostname as a Custom Domain; seeing a DNS record that is in its way |
| User | User Details: Read, Memberships: Read | Wrangler |

Without `CLOUDFLARE_API_TOKEN`, deploy uses the login of `cloudflare/node_modules/.bin/wrangler login`. That login
covers Workers, containers, R2 and the zone, and cannot create API tokens or Access applications or read DNS records.

### What a human still does

Deploy stops with exit code 2 and exact instructions for each of these, goes on with every step that does not
depend on it, and takes the result on the next run:

| When | You do | Then |
| --- | --- | --- |
| The credentials may not create API tokens | Create an R2 "Account API token" in the dashboard: Object Read & Write on the three buckets deploy names | `--r2-access-key-id-file FILE --r2-secret-access-key-file FILE` |
| The credentials may not manage Access | Create the two Access applications deploy describes | `--access-team-domain https://TEAM.cloudflareaccess.com --access-audience AUDIENCE_TAG` |
| The account has no Zero Trust organization, no workers.dev subdomain, or R2 is not enabled | Open the dashboard page deploy names; these need a human's choice or a payment method | run the same command |
| `~/.codex/auth.json` does not exist | `codex login` | run the same command |

Whether the account is on Workers Paid cannot be read through the API; without it the `deploy` step fails with
Wrangler's message. You sign in to Mau with the login methods of your Zero Trust organization, as the address
given with `--owner-email`.

### The deployment directory

`~/.config/mau/deployments/NAME` (or `--dir`), readable by you only, is the deployment as you hold it:

| Path | Content |
| --- | --- |
| `deployment.json` | What was asked for, the identifiers found and made, how each step ended. No secret. |
| `config/` | Exactly what is in the configuration bucket. |
| `secrets/` | The R2 key pair, the gateway's two secrets, and `environment-backup-identity.txt`: the age identity that alone decrypts the backups the gateway makes of partner sandboxes. Keep a copy of it in a password manager. |
| `gateway/`, `*.wrangler.json` | The unpacked gateway source and the two generated Wrangler configurations. |

Keep the directory: an upgrade runs from it. Deploy sets the values it owns in `config/mau.env`, `mau.json` and
`providers.json` (the hostname, the profile `codex`, the provider `cloudflare`, `edgeIdentity`'s team domain,
audience and the owner) and replaces the Host archive and start script of the pinned release. What else you put
there stays and is uploaded: more profiles, service tokens, connector files, `backup.json`. `cloud/host-profile.json`
is written once, because an environment keeps the Host configuration it was created with. The Codex sign-in is
copied once; pass `--codex-auth FILE` to replace it. A new sign-in reaches environments created afterwards.

### mau doctor

```sh
node dist/cli.js doctor [--name NAME | --dir DIR] [--url URL]
```

prints one JSON document of checks, each `{ "check", "ok": true | false | null, "detail", "fix" }` (`null`: could
not be checked, `detail` says why), and exits 1 when a check is false. It reads only. It checks this machine
(Node.js, Docker, Wrangler, cloudflared, Cloudflare credentials); the deployment (every bucket, the R2 key pair,
every object of `config/` against the bucket, the Codex sign-in, the gateway's revision and key, `/health/live`,
that Access protects `/`, the deployed revision and configuration against this checkout and `config/`, whether a
backup is configured); and, with an Access sign-in (`cloudflared access login URL`, or a service token in
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`), the running service: the account, the owner's environment
profiles, and each partner's environment and channels. `--url` alone checks a service you did not deploy.

## How it runs

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

Partners do not run in this container. Each gets a sandbox from the environment gateway, a Worker of its own with
its own containers; Mau reaches it with the control token in `gateway-key`
([environments](environments.md)).

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

`/state/router/tmp` (uploads in progress) is not copied. Attachments are not in `/state`: Router keeps them in
the attachment bucket (`AGENT_BLOB_STORE=r2` in `mau.env`).

## Configuration

The **configuration bucket** is copied to `/config` as it is. A deployment made by `mau deploy` contains:

| Object | Purpose |
| --- | --- |
| `mau.env` | Environment of `mau-server` that differs per deployment ([example](../examples/mau.env)) |
| `mau.json` | Mau's configuration ([example](../examples/mau.json), [environments](environments.md)); paths in it are relative to it |
| `providers.json`, `gateway-key` | The environment gateway's address ([example](../examples/providers.json)) and control token |
| `r2-access-key-id`, `r2-secret-access-key` | The key pair Router keeps attachments in the attachment bucket with |
| `cloud/host-profile.json` | The Host configuration of new environments ([example](../examples/cloud/host-profile.json)) |
| `cloud/agent-host.tgz`, `cloud/agent-host.sha256`, `cloud/start-host.sh` | The pinned Host, its checksum and the script that starts it in a sandbox |
| `cloud/codex-auth.json` | The owner's Codex sign-in, placed in each new environment |
| `backup.json` | Optional: configuration of the daily backup (below) |

The owner's ID is `@owner:HOSTNAME`; the hostname is the namespace of every account and partner ID
(`MATRIX_SERVER_NAME`; no Matrix server is used), so a deployment cannot move to another hostname.

The image sets `HOST`, `PORT`, `MAU_STATE=/state`, `AGENT_SERVICE_STATE=/state/router`,
`MAU_CONFIG_FILE=/config/mau.json`, `MAU_WEB_ROOT` and the Google Workspace CLI path. Configuration is read at
start: the Worker's `CONFIG_REVISION` is a digest of the configuration, so a deploy after a change restarts the
container as for a new image. `SOURCE_REVISION` is the commit the deployment was built from.

The container reads and writes the configuration, state and attachment buckets with its own R2 key pair, the
Worker's `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets. The access-record bucket is written through the
Worker's binding and needs no key.

The gateway admits three environments (`MAX_ENVIRONMENTS`) and four hours of running time a day for each
(`DAILY_RUNTIME_MINUTES`), the defaults of its [example configuration](https://github.com/Olorinm/agent-kit/tree/main/packages/environment/cloudflare).

## Deploys and restarts

A deploy with a changed image or `CONFIG_REVISION` stops the running container as described above and
starts the new one; a deploy that changes only the Worker leaves the container running. A container that exits
on its own is started again within seconds. Requests during a restart get `503` with `Retry-After`.

`RUN` in the Wrangler configuration is the switch: any value but `"true"` stops Mau and keeps it stopped. Use it
before working on the buckets directly: `mau deploy` writes `mau.wrangler.json` in the deployment directory with
`RUN` set to `"true"`; deploy that file by hand with another value
(`cloudflare/node_modules/.bin/wrangler deploy --config DIR/mau.wrangler.json --secrets-file DIR/secrets/worker.json --var RUN:false`).

Without `mau deploy`, the same deployment is made by hand from [`wrangler.example.jsonc`](../cloudflare/wrangler.example.jsonc)
and the examples above; deploy does nothing that these files do not show.

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

The liveness probe (`/health/live`) is not recorded. Records wait in the Durable Object's storage until they are
written out; at most 50,000 wait, and beyond that the oldest are dropped, so a flood of requests cannot fill the
storage. A record that cannot be stored is skipped and the request is still answered (`mau_access_record_failed`
in the Worker's log, at most once a minute). How long the written lines are kept is the bucket's lifecycle rule.

## Daily backup

`mau deploy` configures no backup of Mau's own state: it needs a backup ingress of your own. With `backup.json` in
the deployment's `config/` directory, deploy sets `BACKUP_HOUR_UTC`, and the Durable Object runs Agent Environment's
[`server-backup.py`](https://github.com/Olorinm/agent-kit/tree/main/packages/environment/cloudflare#managed-secrets-network-restrictions-and-independent-backups)
in the container once a day with `/config/backup.json`: an age-encrypted archive of `/state` and `/config`,
uploaded to the backup ingress. `paths` in that file are `["/state", "/config"]`. A failed run is logged as
`mau_upkeep_failed` and tried again an hour later. The copies in the state bucket protect against losing the
container; the backup protects against losing or damaging the bucket.

## Limits

- `mau ssh` needs an HTTP upgrade other than WebSocket, which a Worker does not forward.
- One deployment is one container. Do not point two deployments at the same state bucket.
