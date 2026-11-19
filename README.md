# Mau

Mau is an agent product built on [Agent Kit](https://github.com/Olorinm/agent-kit):

| Component | Responsibility |
| --- | --- |
| [Agent Router](https://github.com/Olorinm/agent-kit/tree/main/packages/router) | Accounts, Agent identities, channels, conversation routing and task delivery |
| [Agent Host](https://github.com/Olorinm/agent-kit/tree/main/packages/host) | Native Agent execution, sessions, tools and approvals |
| [Agent Connectors](https://github.com/Olorinm/agent-kit/tree/main/packages/connectors) | Access to external services, with credentials and write approvals outside the Agent |
| [Agent Environment](https://github.com/Olorinm/agent-kit/tree/main/packages/environment) | Provision, pause, resume and destroy execution environments |
| Mau | Product CLI/API, web console, environment profiles, Host bootstrap and lifecycle coordination |

User/platform → Router → Host → native kernel. Environment supplies the Host's
execution environment. Mau assembles these components; it does not implement a
model loop. Scheduling is not part of this release.

Mau embeds Router in one server process. Router remains separately installable
and runnable. Mau uses only its public package exports; all account authentication
and ownership checks still belong to Router. Product routes use `/_mau/v1` and
communication routes use `/_agent-router/v1`.

## 1. Try it on your machine

With Node.js 24+, a running Docker engine and a Codex sign-in (`codex login`), one command runs the whole product
locally: the server, one owner, and each partner in its own container. See [local mode](docs/local.md).

```sh
git clone https://github.com/Olorinm/mau && cd mau
node scripts/bootstrap.mjs && npm run build
node dist/cli.js local                                      # runs until interrupted; prints what to do next
node dist/cli.js partner create helper --profile codex      # in another terminal
node dist/cli.js chat send helper "hello"
```

Local mode has no login beyond a token in a private file and gives its sandboxes unrestricted network access. It
is for trying Mau out, not for production.

## 2. Deploy your own

Mau runs in your own Cloudflare account. From the same checkout, one command creates the buckets, the two Workers,
the login and the configuration, and the same command upgrades them later; `mau doctor` says what is missing or
broken. See [deployment](docs/deployment.md).

```sh
node dist/cli.js deploy --hostname mau.example.com --owner-email you@example.com
```

## 3. Use the CLI

To drive a deployed Mau from any machine, install the client archive (`olorinm-mau-cli-VERSION.tgz`) attached to a
release on the [Releases page](https://github.com/Olorinm/mau/releases). For example, for version 0.1.0-alpha.43:

```sh
npm install --global https://github.com/Olorinm/mau/releases/download/v0.1.0-alpha.43/olorinm-mau-cli-0.1.0-alpha.43.tgz
mau login https://mau.example.com
mau --help
```

The client has no server or Agent Kit dependencies. [CLI usage](docs/cli.md) has every command and the output
contract for agents that drive it: one JSON document on stdout, one JSON error on stderr, nothing asked
interactively.

## Build

Requires Node.js 24+, npm and curl. For the server, use the verified Node.js 24.22.2 runtime or a newer version that passes the unchanged HTTP security probe. That probe passes on 24.22.2 (matching Docker and CI) and 26.13.0; tested 24.21.0 fails it.

```sh
node scripts/bootstrap.mjs   # downloads the pinned Agent Kit release, installs dependencies
npm run build
npm test
node dist/cli.js --help
```

`components.json` pins one Agent Kit release: its version, source revision and the integrity of each package
archive. Bootstrap downloads the archives into `.packages/` and checks their bytes before installing. Host is kept as
`.packages/agent-host.tgz` for the execution image; it is not installed into the Mau server process. To move to
another release:

```sh
node scripts/pin-kit.mjs <version>   # updates components.json, package.json and both lockfiles
node scripts/bootstrap.mjs
```

A release can be cut from any Agent Kit commit, so a change that spans both repositories can be pinned and tested
here before either side is merged.

The web console's React components are in [`web/ui`](web/ui/README.md), installed and built with the console as one
npm workspace.

An independent consumer installs all required archives together:
`npm install ./router.tgz ./environment.tgz ./connectors.tgz ./mau.tgz`. Host is installed in the
execution image, not the Mau server. The CLI is `mau`; the server is `mau-server`.

## Use

The [web console](docs/web.md) (`MAU_WEB_ROOT`) covers sign-in, agents, environments,
channels and checks in a browser. The CLI offers the same operations.
The console also provides [connector account management](docs/connector-accounts.md)
when a separate OAuth account service is configured. Account connection, Agent tool access
and background permission are separate. [Native work integration](docs/native-work.md)
lets an owner's partners recruit and message each other, and provides bounded Hermes-style memory,
native skill/memory management and persisted proactive rules. Product tools require explicit configuration; no
rules or new account authorizations are created by enabling the integration.

A deployed Mau sits behind Cloudflare Access. The operator supplies the Mau URL and maps your Access email (or an Access
service token) to an owner; Mau does not register a second identity. The CLI stores no Access credential: it reads
one on every call, from `cloudflared` or from private files, never from positional command-line arguments.

```sh
cloudflared access login https://mau.example
mau login https://mau.example
# automation: an Access service token mapped by the operator (read-only unless given "access": "owner")
mau login https://mau.example \
  --access-client-id-file /private/id --access-client-secret-file /private/secret
mau profiles
mau partner create helper --profile codex
mau channel connect helper feishu
mau chat send helper "Hello"
mau partner show helper
mau env pause helper
mau env resume helper
```

See [CLI usage](docs/cli.md) for every command, the other Access credential sources and the output contract
for agents that drive the CLI. Commands name the partner they act on. `--no-wait` returns durable progress;
closing the CLI does not cancel provisioning. `mau env reconcile NAME` resolves an interrupted
operation without allocating a replacement; `mau env destroy NAME --yes` explicitly removes an
environment. Channel pairing/authorization remains implemented by Router. `mau api` lists every HTTP route.

See [environment setup](docs/environments.md) · [中文部署说明](docs/environments.zh-CN.md).
Examples contain placeholders only.
Production configuration, credentials, environment IDs and live state are private.

License: [MIT](LICENSE) for Mau's project-owned code. Source attribution and
third-party licensing boundaries: [NOTICE](NOTICE).

Replacing an Agent's environment: [environment replacement](docs/environment-replacement.md).
