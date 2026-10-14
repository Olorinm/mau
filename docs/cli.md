# Mau CLI

Install Node.js 24 or later, then install the public client archive directly:

```sh
npm install --global https://github.com/Olorinm/mau/releases/download/v0.1.0-alpha.2/olorinm-mau-cli-0.1.0-alpha.2.tgz
mau --version
```

This package needs only Node.js. It does not install the Mau server, Router, Host,
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
operate on the selected Agent. The CLI does not currently provide SSH access.

The local session is stored in `~/.config/mau/session.json`. Run login again if
the server reports an expired account session. `MAU_CONFIG_DIR` selects a separate
local session directory.

Maintainers can build this archive with `npm run pack:cli` and verify a fresh
global installation with `npm run verify:cli` after bootstrapping the source tree.
