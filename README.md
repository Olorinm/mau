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

## Install the CLI

With Node.js 24+, install the client from the public release:

```sh
npm install --global https://github.com/Olorinm/mau/releases/download/v0.1.0-alpha.35/olorinm-mau-cli-0.1.0-alpha.35.tgz
mau --version
```

The client has no server or Agent Kit dependencies. See [CLI usage](docs/cli.md).
The build steps below are for running or developing the server.

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
node scripts/pin-kit.mjs 0.8.0-alpha.1   # updates components.json, package.json and package-lock.json
node scripts/bootstrap.mjs
```

A release can be cut from any Agent Kit commit, so a change that spans both repositories can be pinned and tested
here before either side is merged.

The web console's React components are in [`web/ui`](web/ui/README.md), installed and built with the console as one
npm workspace. See [verification](docs/verification.md) for the package acceptance.

An independent consumer installs all required archives together:
`npm install ./router.tgz ./environment.tgz ./connectors.tgz ./mau.tgz`. Host is installed in the
execution image, not the Mau server. The CLI is `mau`; the server is `mau-server`.

## Use

The [web console](docs/web.md) (`MAU_WEB_ROOT`) covers sign-in, agents, environments,
channels and checks in a browser. The CLI offers the same operations.
The console also provides [connector account management](docs/connector-accounts.md)
when a separate OAuth account service is configured. Account connection, Agent tool access
and background permission are separate. [Native work integration](docs/native-work.md)
provides owner-scoped session tools, bounded Hermes-style memory, native skill/memory management,
and persisted proactive rules. Product tools require explicit configuration; no
rules or new account authorizations are created by enabling the integration.
The console's Files entry is not connected yet.

The operator supplies the Mau URL and a Router/Matrix account. Login reuses that
account; Mau does not register a second identity. Password/token files are local
private files, not positional command-line secrets.

```sh
mau login --url https://mau.example --user '@alice:agents.example' \
  --password-file /private/account-password
mau options
mau setup helper --environment cloud-codex
mau channel-connect feishu
mau check
mau status
mau pause
mau resume
```

Existing account bearer tokens can be supplied using `login --token-file FILE`.
Use `agents` and `use NAME` to switch Agents. `--no-wait` returns durable progress;
closing the CLI does not cancel provisioning. `reconcile` resolves an interrupted
operation without allocating a replacement; `destroy` explicitly removes an
environment. Channel pairing/authorization remains implemented by Router.

See [environment setup](docs/environments.md) · [中文部署说明](docs/environments.zh-CN.md)
and [verification](docs/verification.md). Examples contain placeholders only.
Production configuration, credentials, environment IDs and live state are private.

License: [MIT](LICENSE) for Mau's project-owned code. Source attribution and
third-party licensing boundaries: [NOTICE](NOTICE).

Replacing an environment and composing server-side read tools:
[environment migration](docs/environment-migration.md).
