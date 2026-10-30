# Mau CLI

Install Node.js 24 or later, then install the public client archive directly:

```sh
npm install --global https://github.com/Olorinm/mau/releases/download/v0.1.0-alpha.10/olorinm-mau-cli-0.1.0-alpha.10.tgz
mau --version
```

This package uses Node.js; SSH additionally requires local `ssh` and `ssh-keygen`.
It does not install the Mau server, Router, Host,
or the private Environment package. It is distributed through GitHub Releases;
`npm install -g @olorinm/mau-cli` from the npm registry is not available.

Your operator supplies a service URL, an account, and access to an environment
profile with model access configured. Save your password in a private local file.

```sh
mau login --url https://mau.example --user '@alice:agents.example' --password-file /private/password
mau options
mau setup helper --environment cloud-codex
mau channel-connect feishu
mau check
mau status
```

Follow the links or QR codes to connect your own channel. To select an Agent that
already exists, use `mau agents` and `mau use NAME` instead of `setup`.
One account can own several Agents. Each cloud Agent gets its own environment;
logging in alone does not allocate a container. `mau pause` and `mau resume`
operate on the selected Agent.

When the environment profile enables SSH, connect to an existing Agent:

```sh
mau ssh helper
mau ssh helper -- uname -a
```

The first command opens an interactive shell; the second executes a command and
preserves its exit status. The service checks account ownership and tunnels native
OpenSSH through its HTTPS endpoint. No container IP, cloud API key or deployment
SSH key is needed. Temporary client keys are removed when the command exits; new
authentication expires after ten minutes. The host key is verified against the
authenticated service response. An SSH session lasts at most eight hours.

Resume a paused environment with `mau use helper` and `mau resume` first. Close
active SSH sessions before pausing or destroying it. Shell access uses the same
execution user and can read the files and credentials available to that user.

The local session is stored in `~/.config/mau/session.json`. Run login again if
the server reports an expired account session. `MAU_CONFIG_DIR` selects a separate
local session directory.

Maintainers can build this archive with `npm run pack:cli` and verify a fresh
global installation with `npm run verify:cli` after bootstrapping the source tree.

The workspace commands require the 0.1.0-alpha.4 client build. Until published,
build its independent archive with `npm run pack:cli` and install the resulting
`.packages/olorinm-mau-cli-0.1.0-alpha.4.tgz` locally.

```sh
mau workspace-create project
mau setup designer --environment shared-codex --workspace WORKSPACE_ID
mau setup developer --environment shared-codex --workspace WORKSPACE_ID
mau workspaces
```

Use an operator-provided profile with workspace support. Omitting `--workspace`
creates an independent persistent workspace. The same account can share one
workspace among Agents; credentials and native sessions remain per environment.

## Recover Feishu setup

Recovery requires Mau CLI 0.1.0-alpha.6 and Router 0.7.0-alpha.3 or later. App consent connects bot messaging immediately. Personal tools
request separate authorization when needed, or with `mau channel-auth feishu begin`
and `mau channel-auth feishu complete`. `--messaging-only` omits personal tools.

If your app is already created but Mau setup expired, keep that app and use its
App ID from the developer console:

```sh
mau use helper
mau channel-jobs
mau channel-connect feishu --app-id cli_YOUR_EXISTING_APP_ID
mau check
```

The official consent page reauthorizes the selected app; no App Secret needs to be
copied into the CLI or chat. Keep `--domain lark` and `--messaging-only` if used in
the original setup. If credentials were saved before binding failed, retry reuses
them. An app already assigned to another Agent cannot be reused here.

Feishu consent follows the official SDK's reported expiry and fallback; Router
does not impose a separate ten-minute consent limit. Recent job history survives service
restarts; an interrupted SDK poll requires a new consent flow for the existing
app. `channel-job ID` observes a still-running job. Failed jobs include recovery
instructions. Do not delete a pending marker to force creation of a second bot.

`mau check` reports missing connections explicitly and checks the Feishu bot and
personal authorization separately. Host readiness alone does not verify messaging;
send a real message to test the complete conversation path.
