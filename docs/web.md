# Web console

[简体中文](web.zh-CN.md)

The console (`web/src`) composes the page layouts (`@olorinm/agent-ui/pages`) with the
lower-level components (`@olorinm/agent-ui`, `@olorinm/agent-ui/app`) of the UI package in
[`web/ui`](../web/ui/README.md). The package receives data, React content and callbacks; it has
no Mau, Router, Host or Environment dependency. Authentication, navigation, requests and the
environment/channel workflows are in `web/src`.

The console covers conversations with owned Agents (direct chats and groups), Agent creation and
management, environment lifecycle, channel connections, connector accounts and settings. It talks only
to Mau (`/_mau/v1`) and the embedded Router (`/_agent-router/v1`) on its own origin; the browser never
receives Host credentials or reaches an environment directly. App creation is a visible entry that says
"Not connected yet"; it has no backend. The owner's apps come from the deployment's app service, when it has one
([Apps](#apps)).

`web/` is an npm workspace: `web/package-lock.json` locks the console and `web/ui` together, and
the console depends on the workspace package directly. `npm run build:web` builds `web/ui` first.

## Develop

```sh
node scripts/bootstrap.mjs            # also installs web/ dependencies
MAU_CONFIG_FILE=/private/mau.json npm start
npm run dev:web                        # builds web/ui, then Vite on :5173, proxying /_mau and /_agent-router to :8790
```

Set `MAU_DEV_BACKEND_URL` to proxy to another server.

## Deploy

```sh
npm run build:web
MAU_WEB_ROOT=web/dist MAU_CONFIG_FILE=/private/mau.json npm start
```

With `MAU_WEB_ROOT`, `mau-server` serves the console from the same origin as its
API, so no CORS configuration is needed. Paths beginning with `/_` and the
`/health` routes are never answered with the page. The [Dockerfile](../Dockerfile) builds the console and sets
`MAU_WEB_ROOT=/app/web`.

The server release archive also includes `web/dist`. After installing the archive,
point `MAU_WEB_ROOT` to that directory inside the installed Mau package. `npm pack`
builds both server and console before packaging.

The page's Content Security Policy allows connections only to the same origin. The only
framed page is the live browser view an Agent hands to its owner.

## Login (Cloudflare Access)

Behind Cloudflare Access the console has no login page and stores no token. Its login is the edge identity: with `edgeIdentity`
in `mau.json` (the shape of Router's `edgeIdentity`), Router verifies the `Cf-Access-Jwt-Assertion` JWT on
every `/_mau/v1` and `/_agent-router/v1` owner request and on the SSH upgrade, and maps its email (or a
configured service token) to an owner. The plain email header and the `CF_Authorization` cookie are never
trusted. A service token is not the owner's sign-in: unless its `serviceTokens` entry is
`{ "owner": "...", "access": "owner" }`, it only reads (`GET`, `HEAD`; not the SSH upgrade) and, on Router's web
routes, sends a chat message, opens a DM chat, marks a chat read and requests a socket ticket. Every other request,
which is every write under `/_mau/v1`, answers `403 owner_sign_in_required` (with `scope`, what the route needs, on
Mau's routes) unless it carries an access token of the same owner in the `Mau-Token` header whose scopes cover it.
The owner creates such tokens (`mau token create`, `POST /_mau/v1/tokens`): each has scopes (`chat`, `approve`,
`manage`), expires within 90 days and can be revoked; only its digest is stored. A token is consulted for a
verified service token only, never signs anyone in, and never reaches the owner's own routes (the tokens
themselves, purging a chat, linking identities); an allowed write still needs the service's own `Origin`.
`"access": "owner"` remains the unscoped alternative. See [Giving an agent access](cli.md#giving-an-agent-access).
`GET /_mau/v1/info` returns `{ "login": "edge", "logoutUrl": "/cdn-cgi/access/logout" }`.

A service started by [`mau local`](local.md) has no edge identity. `GET /_mau/v1/info` returns `{ "login": "local" }`
there, and the console signs in with the local owner token: `mau local` prints the console's address with the token
in its fragment, the page keeps the token in that tab's `sessionStorage`, removes it from the address and sends it
as a bearer header (the event socket through its single-use ticket, attachments through the same header). A tab
without the token shows where it comes from. Signing out forgets the token.
Mau does not start without `edgeIdentity` (`edge_identity_required`) or without Router's ledger
(`ledger_read_required`).

- Boot reads `GET /_mau/v1/account` with the same-origin Access cookie; Cloudflare adds the JWT.
- An account that is not mapped gets a full page naming its email, with "Switch account" (Access logout).
- An expired Access session (an API redirect, a `401`, or a socket re-ticket that fails) shows a banner.
  "Sign in again" keeps unsent composer text in `sessionStorage` and reloads the page.
- "Sign out" goes to the Access logout.
- Cloudflare adds the JWT to cross-site requests too, so Router accepts an unsafe (non-GET) edge request only with
  an `Origin` of the console (`edgeIdentity.origins`, default the public URL's origin, or the request's own host)
  and a JSON-like body type. Non-browser callers behind Access (the CLI) send an explicit `Origin`.

## Conversations

Chats are served by Router's owner ledger (`/_agent-router/v1/web`); the console follows the feature flags
Router advertises in `GET /web/me`. Without `history` the console reports that chat history is unavailable;
without `send` conversations are read-only.

- Each owned Agent has one direct chat. The list of conversations stands beside the conversation (on a phone it
  is the first page), each row with its last message and what is unread. The name in a conversation's header, or
  the row's own button, opens the Agent's profile in the list's place: environment state and checks, channels, connectors, documents,
  and configuration (kernel, model and reasoning effort where the runtime allows a choice, environment profile,
  destroy the environment, delete the Agent).
- A new partner takes a name, an optional duty (one line of at most 200 characters, shown under its name on the
  profile) and either an environment of its own or the environment of another of the owner's partners
  ([shared environments](environments.md#partners-sharing-an-environment)). Its own environment is the default;
  sharing is offered when a partner has an environment of its own that is not destroyed. A partner created in a
  shared environment is usable when the request returns. Its profile names the partner whose environment it runs in
  and has no pause, resume, reconcile or destroy; its checks, documents and settings are its own. The profile of
  the partner that has the environment lists the partners sharing it; destroying that environment or deleting that
  partner is refused, naming them, until they are deleted.
- The third choice for a new partner is "My computer": the partner
  is an agent already installed on the owner's computer. The dialog then shows, once, the pairing code and the
  command to run there. Its profile has "Device" in place of the environment (state, name, platform, kernel, last
  online, pair again, unpair), no capabilities or documents, and neither a model nor an environment to destroy
  under configuration; in the list its state is waiting to pair, online or offline. See
  [Connect an agent on your computer](external-agents.md).
- "New group" creates a Router group room with a title and up to 20 of the owner's Agents. In a group only
  the Agents the owner @-mentions (or everyone, with `@all`/`@所有人`) start work; a message without a
  mention is only recorded. The member panel renames the group and adds or removes Agents.
- Messages carry text and attachments (when Router advertises them): images are shown inline, other files
  as download cards. Messages that arrived on another channel are labelled with it.
- A failed send keeps the draft for a retry with the same idempotency key.
- "New chat" starts a fresh session, and settings can clear a chat's history, when Router offers `reset`.
- An Agent's instructions (`AGENTS.md`, read-only) and its memory (`MEMORY.md`, edited as one
  document) open beside the conversation.

Host health alone does not verify message routing; live acceptance must send a
message through the console and observe the Agent's reply.

## Execution and interactions

The console reads runs through Router's public run, event and call-result APIs. It shows streamed text,
reasoning, tool arguments and results, run state and pending approvals or questions under the message that
started them. Owners answer approvals and questions, stop a running reply, or send text into it, all
through Router. Native choices and answer formats come from Host's public interaction helpers; Mau does
not define its own approval options. An approval that was answered or ended is not a record of its own:
the step it asked about says in the process how it ended (declined, canceled), and a step that ran after
being allowed is a step like any other. Without that step it is one row of the process, which opens to the
command it asked about.

A reply's steps are behind one collapsed line that counts them by kind ("Explored 2 files · Ran 4 commands ·
Asked reviewer"). Opened, each step is one row that says what was done:

- a command is named by the sentence its kernel's model wrote for it (Claude's `description`), and otherwise by
  the programs it ran ("Ran git status, git log, head"), never by the command line;
- Codex's own reading of a command (read, list, search) and the `kind` and `locations` an ACP agent gives a call
  decide what kind of step it is before the command's first word is guessed at;
- files read one after another are one row that names them;
- what a kernel does for itself is not a step: Claude loading a tool's definition, and Claude's own report of a
  product tool the Host already reports.

A row is its title alone. The chevron at its end opens what the step ran, said or printed: the command with its
output, a thought, a partner's message as it was written, or a tool's arguments and result.

Event cursors resume after a disconnection. A refresh rebuilds the run from retained history and reports
lost events explicitly; a finished run is read once from Router's archive. Closed or expired interactions
are disabled. When an Agent hands its browser to the owner, the live view opens beside the conversation.

The build-version watcher reloads an outdated page only when it is idle: never during a pending change,
an open dialog or form, or while an input has focus.

## Partners working together

Partners recruit and message one another with the `partners` tool ([Partners](native-work.md#partners)). The
console shows that work in the conversations it belongs to.

- **Threads.** A piece of work another partner sent a partner runs in a session of its own, and the console shows
  it as a thread of that partner's page. The round it began with stands in the conversation where it began, as a
  reply does. When more rounds followed, a line under it names the work, says how many rounds there are and how
  the last one stands, and opens the thread beside the conversation: the round it began with, a rule that counts
  the replies, and each later round as what the other partner asked (its first lines, and the rest when asked
  for) and what this partner answered. The later rounds are not laid out in the conversation. A thread with
  something new has a dot on its line, and a line above the composer says which thread it is and opens it; a
  thread that is open is read. The box in the thread writes in that session: a turn of the session with the
  owner's own words, of which the partner that opened it is not told. A thread whose session was closed says so,
  can be read and cannot be written in. The list of conversations has one row for a partner: what is new or
  running in its threads shows on that row, and searching a conversation reaches into its threads.
- **Messages and results.** A partner's message is a turn of a session of the recipient, and its result returns
  to the conversation the message was sent from. Either one is the first step of the reply it started: a row
  under the other partner's figure ("Asked by chief", "Reply from reviewer") whose name opens the conversation
  with that partner and whose chevron opens what the partner wrote. The reply's collapsed line begins with it in
  the reply's own voice ("Reply from reviewer · Ran 1 command · Asked reviewer"), and names the work when the
  work is one round ("Asked by chief: Review the pricing plan"), so a conversation reads as the owner and one
  partner; a reply that is still working or did not finish says who wrote in all the same ("Asked by helper ·
  Failed"). A result that is not a whole answer says so under its row: not completed, stopped, not run or
  outcome unknown (with the reason in a sentence where the console has one), or that a long answer was shortened
  and is whole in that partner's conversation. Where no reply followed (a result handed over in a notice), the
  message stands by itself under its partner's figure and name, as it was written. The console takes all of this
  from the `display` Mau records with the event, never from the text written for the model; an event recorded
  without `display` shows its whole text as it is.
- **The list of conversations** previews a conversation's last event only when a person or the conversation's own
  partner wrote it. What another partner sent into it, and a system line, is not a preview.
- **The `partners` tool in a run's process.** Each call is one row (looked at the partners, recruited, passed on,
  asked, informed, waited, dismissed) under the figure of the partner it names, whose name is a link. The chevron
  opens what the partner was told, or the call's arguments and result where nothing was told. A refused call says
  why in a sentence.
- **Approval cards.** When a partner's operation needs the owner's approval, the card appears in the conversation
  the message was sent from, under the asking partner's figure and name. The console words it in the interface
  language from the members of the request: who asks, whose message it handles, the operation, the connection and
  the arguments, which are always shown whole. The two choices follow the interface language
  too. A card recorded without those members shows the server's text and choices. A card is answered once, and then
  shows whether it was approved, declined, expired, withdrawn or answered elsewhere. A partner that waits for an
  approval says so in the list of conversations.
- **Dismissed partners** leave the list. A row at the end of the partners opens them, each with
  its restore, and a search finds them by name. A profile's configuration dismisses and restores a partner, apart
  from deleting it; a dismissed partner keeps its conversation and memory. Settings leave it out as well: 消息渠道
  does not list its channels, and a connector's page does not name it among the partners using the connection.
- **Profile.** A profile names the partner that recruited it and the partner whose environment it runs in, as
  lines that open that partner's profile. Its configuration shows the kernel the partner itself runs on (partners
  of one environment can run on different kernels), with the models and reasoning efforts of that kernel.
- **Kernel of a new partner.** When the environment of the partner chosen under "Share with a partner" offers more
  than one kernel, the dialog asks which one the new partner runs on; the environment's main kernel is the default.
  An environment with one kernel shows no choice. A kernel the environment does not offer, or whose runtime is not
  available there at the moment, is refused in a sentence.

## Apps

The apps destination lists the owner's apps: a grid under the destinations in a wide window, a dial above them on a
phone (a drag turns it, a press opens an app). An app opens in a tab of its own.

- **Where they come from.** `GET /_mau/v1/apps` answers `{ configured, data }`, each app `{ id, name, url, icon? }`.
  Mau has no app service of its own: a deployment gives one to `createMau` as `dependencies.apps`, an object with
  `list(owner)` (`AppDirectory` in the package's types). Without it the answer is `{ configured: false, data: [] }`
  and the apps destination leads straight to app creation.
- **What is kept.** `url` is an https address or a path of the console's origin; `icon` is a path of the console's
  origin, since the console's content policy loads images from nowhere else. An entry without an id, a name or such
  an address is left out; an icon that is not such a path is dropped and the console draws the name's first letter.
- **Pinned apps.** Up to three apps stand among the destinations, between the conversations and the apps. In the
  grid each app has a pin; on a phone the app in the middle of the dial has its pin under its name, and a held app
  can be carried onto the destinations. The choice is kept in the browser (`localStorage`, `mau.pinnedApps`), not
  on the server: another browser starts without it.

## Settings

The account, the last of the destinations at the top (on a phone: beside the mark, above the list), opens the
settings: a modal over the app with a left navigation: 通用 (language,
theme, avatars), 连接器, 消息渠道, 身份与配对, 扩展, 数据控制 (clear a chat's history through Router's ledger purge),
帮助与法律 and 退出 (the edge login's logout). An Agent's own state and configuration are on its profile. 扩展 lists Skills, MCP, kernel plugins, Hooks, Tools and CLI as not connected: Agents install and use
them in their own environment.

Pages are deep-linkable: `#/settings/<section>[/<item>]`, for example `#/settings/connectors/gmail`. Before an OAuth
redirect the console remembers the page; the callback's `/?view=connectors&oauth=…` reopens it. Below 640 px the modal
fills the screen, the navigation is its first page and each page has a back button.

Surfaces, type scale, spacing and components come from `@olorinm/agent-ui/app` (standard density for settings, compact
for run details and approval cards).

## Channels

Channels are connected per Agent in 设置 → 消息渠道, inside the modal. Router setup jobs are polled every
two seconds, including after temporary network, server or rate-limit errors. Errors show a retry button;
missing or expired jobs stop polling. Router's `qr` field is a terminal drawing; the console renders its
own QR code from the job's `https` link and offers the same link to open. Jobs live ten minutes in Router
memory; an expired or unknown job asks the user to start again. Feishu personal access (acting as the
owner) is authorized in 设置 → 连接器 → 飞书 through Agent Connectors; see
[connector-accounts.md](connector-accounts.md).

### Recover an existing Feishu app

On Feishu connection failures, choose **Recover connection** and enter the original
App ID from the developer console. The console preserves the known App ID and
region. The official consent page restores access to that app;
no App Secret is copied. Saved credentials are reused when only binding failed.
Failed setup jobs remain available after a Router restart.

## Verify

```sh
npm run test:web
```

This builds the console, runs the connection-layer tests and drives Chromium against a fixture Mau:
opening from the Access session, Agent creation, sharing an environment, pause and resume, channel connection,
checks, destruction, settings and connectors, conversations, groups, attachments, run details and approvals,
partners working together (messages and results, approval cards, dismissal, kernels), language switching,
sign-out and an expired session. CI sets `MAU_WEB_E2E=1` so a missing build fails
rather than skips. Cloud lifecycle, Host, Access and channels are fixtures; QR scanning, a real Access
login, channel authorization and model replies need deployment-specific acceptance.
