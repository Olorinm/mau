# Mau CLI

Install Node.js 24 or later, then install the client archive (`olorinm-mau-cli-VERSION.tgz`) attached to a release
on the [Releases page](https://github.com/Olorinm/mau/releases). For example, for version 0.1.0-alpha.43:

```sh
npm install --global https://github.com/Olorinm/mau/releases/download/v0.1.0-alpha.43/olorinm-mau-cli-0.1.0-alpha.43.tgz
mau --version
```

This package uses Node.js; SSH additionally requires local `ssh` and `ssh-keygen`.
It does not install the Mau server or any Agent Kit package. It is distributed through GitHub Releases;
`npm install -g @olorinm/mau-cli` from the npm registry is not available.

Commands are `mau <noun> <verb> [NAME] [arguments]`. A partner is always named by its NAME; there is no
selected partner. `mau help` lists every command, `mau <noun> --help` adds the options of one group.

## Run Mau on this machine

```sh
node dist/cli.js local [--dir DIR] [--port PORT] [--codex-auth FILE] [--sandbox-proxy URL]
```

From a source checkout, `mau local` runs the whole service on `127.0.0.1` until it is interrupted, with partner
environments as local Docker containers, and signs this CLI in to it: every command below then works without
Cloudflare Access. It prints one JSON document when the service is ready (`url`, `owner`, `dir`, `console` when the
web console is built, `next`); the server's log goes to stderr. The installed client archive has no server and
answers `local_requires_source_checkout`. See [local mode](local.md) for what it needs, keeps and does not protect.

## Sign in

A deployed Mau sits behind Cloudflare Access. Your operator supplies the service URL, maps your Access email (or an
Access service token) to an account, and assigns an environment profile with model access configured.

```sh
cloudflared access login https://mau.example
mau login https://mau.example
mau whoami
# automation: an Access service token mapped by the operator. It can read; commands that change something
# answer owner_sign_in_required unless the operator gave the token "access": "owner" (see web.md).
mau login https://mau.example --access-client-id-file /private/id --access-client-secret-file /private/secret
```

`mau login` saves the service URL and your owner name in `~/.config/mau/session.json` (`MAU_CONFIG_DIR` selects
another directory); `mau logout` removes it. No credential is saved. Every command reads the Access credentials
again, from the first of these that is present: a service token
(`--access-client-id-file` and `--access-client-secret-file`, or `CF_ACCESS_CLIENT_ID[_FILE]` and
`CF_ACCESS_CLIENT_SECRET[_FILE]`), an Access token (`--access-token-file` or `CF_ACCESS_TOKEN[_FILE]`), or
`cloudflared access token`. The URL must be `https://`; `http://` is accepted for a loopback host only.

A local sign-in is written by `mau local`, not by `mau login` (which answers
`local_service_signs_in_with_mau_local` for such a service): the session names the file with the local owner
token, which is read on every request and sent as a bearer header to the loopback address only. While
`mau local` is not running, commands answer `service_unreachable` with `"fix": "mau local"`.

## Partners and environments

```sh
mau profiles                                              # the environment profiles you can use
mau partner create helper --profile codex --duty "Keeps my calendar"
mau partner create scout --share helper                   # runs in helper's environment
mau partner list
mau partner model helper --set model=MODEL_ID --set effort=high
mau env pause helper
mau env resume helper
mau ssh helper -- uname -a
```

`partner create` waits until the environment is ready. One account can own several partners; each gets its own
environment unless it is created with `--share`. `mau partner delete NAME --yes` permanently deletes a partner: it
destroys every cloud environment it still has and removes its memory, schedules, channel connections and product
records. Sent messages stay in chat history. It is refused while work or a scheduled run is in progress. If it
stops partway, the partner stops receiving messages and running the command again finishes it. A partner that
runs in another partner's environment leaves that environment in place; a partner whose environment is still
shared is refused (`environment_shared_by_partners`) until the sharing partners are deleted. See
[Partners sharing an environment](environments.md#partners-sharing-an-environment).
`mau partner dismiss NAME` only archives a partner; `mau partner restore NAME` brings it back.

`mau env reconcile NAME` resolves an interrupted operation without allocating a replacement; `mau env destroy NAME
--yes` removes the environment and keeps the partner; `mau env create NAME --profile ID` gives a partner without an
environment a new one. `mau env replace NAME --profile ID` and `mau env rollback NAME` are described in
[environment replacement](environment-replacement.md).

When the environment profile enables SSH, `mau ssh NAME` opens an interactive shell and `mau ssh NAME -- COMMAND`
executes a command and preserves its exit status. The service checks account ownership and tunnels native
OpenSSH through its HTTPS endpoint. No container IP, cloud API key or deployment
SSH key is needed. Temporary client keys are removed when the command exits; new
authentication expires after ten minutes. The host key is verified against the
authenticated service response. An SSH session lasts at most eight hours.
Resume a paused environment first. Close active SSH sessions before pausing or destroying it. Shell access uses
the same execution user and can read the files and credentials available to that user.

## Chat and cards

```sh
mau chat send helper "What is on my calendar tomorrow?"
mau chat show helper --limit 10
mau card list
mau card answer helper CARD_ID Allow
```

`chat send` writes in your direct chat with the partner and waits for its turn. The result has `state`, the
partner's `replies` and `pendingCards`. `state` is `completed`, or `waiting` when the partner asked you something:
answer with `mau card answer NAME CARD_ID ANSWER`, where ANSWER is one of the card's `choices` (its `choiceId` or
its `label`), or free text when the card has `freeText`. `card answer` then waits for the partner's turn in the
same way. A turn that fails, is cancelled or has an unknown outcome is a failure (`turn_failed`, `turn_canceled`,
`turn_unknown`). `--no-wait` returns at once with `state` `queued`; read the chat with `chat show` later. `mau chat stop NAME` stops a
running turn. `mau chat new NAME` starts a new conversation in the same chat. Text that begins with `-` goes after `--`: `mau chat send helper -- "-1"`.

## Memory

```sh
mau memory show helper
mau memory add helper "The owner prefers short answers."
mau memory log helper                       # the last changes, each with its id
mau memory undo helper MUTATION_ID
```

`memory replace NAME OLD_TEXT TEXT` and `memory remove NAME OLD_TEXT` change the one entry that contains OLD_TEXT.

## Channels

```sh
mau channel connect helper feishu
mau channel list helper
mau channel access helper CONNECTION_ID --groups GROUP_ID,GROUP_ID
mau channel disconnect helper CONNECTION_ID --yes
```

`channel connect NAME feishu|weixin|telegram|grove-mail` prints the consent link (and QR code) on stderr and waits
until the channel is connected. With `--no-wait` it returns as soon as there is something for you to do; the result
then has `needsOwner`. `channel jobs NAME` lists recent jobs, `channel job NAME JOB_ID` follows one, and
`channel pair NAME JOB_ID --code-file FILE` gives a job the pairing code its channel showed you.
`channel list` checks the connections now; host readiness alone does not verify messaging, so
send a real message to test the complete conversation path.
`channel access` without options shows who else may talk to the partner through a connection (`groupIds`,
`peerAddresses`); `--groups` or `--peers` replaces that list, and an empty value empties it.
`channel disconnect` and `channel access` need a Router release that serves the connection routes.

### Recover Feishu setup

App consent connects bot messaging immediately. If your app is already created but Mau setup expired, keep that
app and use its App ID from the developer console:

```sh
mau channel jobs helper
mau channel connect helper feishu --app-id cli_YOUR_EXISTING_APP_ID
mau partner check helper
```

The official consent page reauthorizes the selected app; no App Secret needs to be
copied into the CLI or chat. Keep `--domain lark` if used in
the original setup. If credentials were saved before binding failed, retry reuses
them. An app already assigned to another partner cannot be reused here.

Feishu consent follows the official SDK's reported expiry and fallback; Router
does not impose a separate ten-minute consent limit. Recent job history survives service
restarts; an interrupted SDK poll requires a new consent flow for the existing
app. A failed job's error has `recover`, the command that continues. Do not delete a pending marker to force
creation of a second bot.

## Connectors

```sh
mau connector list
mau connector assign alice-gmail helper     # helper can use the connection
mau connector unassign alice-gmail helper
mau connector policy alice-gmail --set gmail.send=ask
mau connector connect alice-feishu --partner helper
```

`connector assign` and `unassign` set which partners can use a connection; see
[when a change takes effect](connector-accounts.md#which-partners-can-use-a-connection).
`connector policy ID` shows the connection's operations; `--set OPERATION=allow|ask|deny` changes them and `--reset`
returns all to their defaults. `connector sites ID` shows a browser connection's site access; `--mode direct|ask`
and `--remove HOST` change it (sites are added by answering the partner's card, not here).

`connector connect ID` authorizes a connection. Feishu personal access (acting as the owner) uses a device consent:
the command prints the link, waits until you confirm it, and with `--no-wait` returns the link in `needsOwner`;
`--partner NAME` first gives the connection the app of that partner's Feishu chat channel, as the console does.
OAuth connections (Gmail and others) cannot be authorized from the CLI: the service binds the provider's redirect
to the browser that started the consent. The command fails with `connector_consent_requires_console` and
`needsOwner` names the console's connector page, where you start it. `connector disconnect ID --yes` removes an
authorization.

## Every route

```sh
mau api                                     # every HTTP route: method, path, summary, body schema
mau api GET /_mau/v1/proactive
mau api POST /_mau/v1/proactive/RULE_ID/state --data '{"status":"paused"}'
```

`mau api METHOD PATH` calls any route under `/_mau/v1` or `/_agent-router/v1` with your sign-in and prints its
JSON answer; `--data-file FILE` reads the body from a file. `mau api` lists the routes from the service
(`GET /_mau/v1/reference`): Mau's under `/_mau/v1`, then Router's under `/_agent-router/v1`.

## For agents

- stdout is exactly one JSON document: the result. Only `mau help`, `--help` (usage text) and `mau ssh`
  (the remote command's own output) differ.
- stderr carries progress for people: links and QR codes. When a command fails, its exit code is 1, stdout is
  empty, and the last stderr line is one JSON object `{"error":"<code>", ...}`. The code is snake_case; the other
  members are what the service returned with it, plus `httpStatus` for a refused request and `usage` for a command
  that was not understood.
- Nothing is asked interactively. Commands that cannot be undone need `--yes` (`confirm_with_yes` without it).
- Commands that take time wait for the outcome; `--no-wait` returns the current state instead.
- When a person has to act, the result (or the error) has `needsOwner`: `{"action":"open_link","url":"…"}`,
  `{"action":"enter_pairing_code","command":"…"}` or `{"action":"connect_in_console","url":"…"}`. Hand it to the owner.
- Secrets are read from files (`--bot-token-file`, `--api-key-file`, `--code-file`, the Access options), never from
  argument values.
- Results are the service's own JSON. `mau api` lists every route with its body schema, for what has no command.
- `mau local` is the one command that keeps running: its one JSON document is printed when the service is ready, and
  it exits 0 when it is interrupted. `mau deploy` and `mau doctor` also print one document; their exit codes are in
  [deployment](deployment.md).

Maintainers can build this archive with `npm run pack:cli` and verify a fresh
global installation with `npm run verify:cli` after bootstrapping the source tree.
