# Mau

Mau is an agent product built from three independently reusable components:

| Component | Responsibility |
| --- | --- |
| [Agent Router](https://github.com/Olorinm/agent-router) | Accounts, Agent identities, channels, conversation routing and task delivery |
| [Agent Host](https://github.com/Olorinm/agent-host) | Native Agent execution, sessions, tools and approvals |
| [Agent Environment](https://github.com/Olorinm/agent-environment) | Provision, pause, resume and destroy execution environments |
| Mau | Product CLI/API, environment profiles, Host bootstrap and lifecycle coordination |

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
npm install --global https://github.com/Olorinm/mau/releases/download/v0.1.0-alpha.2/olorinm-mau-cli-0.1.0-alpha.2.tgz
mau --version
```

The client has no server or private component dependencies. See [CLI usage](docs/cli.md).
The build steps below are for running or developing the server.

## Build

Requires Node.js 24+, npm and an authenticated GitHub CLI (`gh auth login`). The components are not assumed to be on npm.
`components.json` pins component source revisions and immutable release archives.
Router and Host releases are public. Agent Environment 0.2.0-alpha.1 is extracted
from OMA and distributed in its private repository; the signed-in GitHub account
must have access. Bootstrap verifies the actual archive bytes against the lockfile.
Environment uses an uncompressed npm tar archive so CI can reproduce the same
bytes across platforms without differences from gzip implementations.

```sh
node scripts/bootstrap.mjs
npm run build
npm test
node dist/cli.js --help
```

Use `--router-archive /path/router.tgz --environment-archive /path/environment.tar`
when supplying the pinned archives locally.
See [verification](docs/verification.md) for the shared-source acceptance.

An independent consumer installs all required archives together:
`npm install ./router.tgz ./environment.tgz ./mau.tgz`. Host is installed in the
execution image, not the Mau server. The CLI is `mau`; the server is `mau-server`.

## Use

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

License: [Apache-2.0](LICENSE). Source attribution: [NOTICE](NOTICE).
