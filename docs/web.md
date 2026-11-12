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
receives Host credentials or reaches an environment directly. App creation and the App Store are visible
entries that say "Not connected yet"; they have no backend.

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

The console has no login page and stores no token. Its only login is the edge identity: with `edgeIdentity`
in `mau.json` (the shape of Router's `edgeIdentity`), Router verifies the `Cf-Access-Jwt-Assertion` JWT on
every `/_mau/v1` and `/_agent-router/v1` owner request and on the SSH upgrade, and maps its email (or a
configured service token) to an owner. The plain email header and the `CF_Authorization` cookie are never
trusted. `GET /_mau/v1/info` returns `{ "login": "edge", "logoutUrl": "/cdn-cgi/access/logout" }`.
Mau does not start without `edgeIdentity` (`edge_identity_required`) or without Router's ledger
(`ledger_read_required`), and it always runs Router with Matrix off: no homeserver is configured or contacted.

- Boot reads `GET /_mau/v1/account` with the same-origin Access cookie; Cloudflare adds the JWT.
- An account that is not mapped gets a full page naming its email, with "Switch account" (Access logout).
- An expired Access session (an API redirect, a `401`, or a socket re-ticket that fails) shows a banner.
  "Sign in again" keeps unsent composer text in `sessionStorage` and reloads the page.
- "Sign out" goes to the Access logout.
- Bearer callers (the CLI, automation) keep working unless Router's `bearer` is `"deny"`.
- Cloudflare adds the JWT to cross-site requests too, so Router accepts an unsafe (non-GET) edge request only with
  an `Origin` of the console (`edgeIdentity.origins`, default the public URL's origin, or the request's own host)
  and a JSON-like body type. Non-browser callers behind Access send a bearer token or an explicit `Origin`.

## Conversations

Chats are served by Router's owner ledger (`/_agent-router/v1/web`); the console follows the feature flags
Router advertises in `GET /web/me`. Without `history` the console reports that chat history is unavailable;
without `send` conversations are read-only.

- Each owned Agent has one direct chat. A few conversations stay in the header row; the people panel lists
  all of them and opens an Agent's profile: environment state and checks, channels, connectors, documents,
  and configuration (kernel, environment profile, destroy the environment, delete the Agent).
- "New group" creates a Router group room with a title and up to 20 of the owner's Agents. In a group only
  the Agents the owner @-mentions (or everyone, with `@all`/`@所有人`) start work; a message without a
  mention is only recorded. The member panel renames the group and adds or removes Agents.
- Messages carry text and attachments (when Router advertises them): images are shown inline, other files
  as download cards. Messages that arrived on another channel are labelled with it.
- A failed send keeps the draft for a retry with the same idempotency key.
- "New chat" starts a fresh session, and settings can clear a chat's history, when Router offers `reset`.
- An Agent's instructions (`AGENTS.md`, read-only) and its two memory files (`MEMORY.md`, `USER.md`,
  edited one entry at a time) open beside the conversation.

Host health alone does not verify message routing; live acceptance must send a
message through the console and observe the Agent's reply.

## Execution and interactions

The console reads runs through Router's public run, event and call-result APIs. It shows streamed text,
reasoning, tool arguments and results, run state and pending approvals or questions under the message that
started them. Owners answer approvals and questions, stop a running reply, or send text into it, all
through Router. Native choices and answer formats come from Host's public interaction helpers; Mau does
not define its own approval options.

Event cursors resume after a disconnection. A refresh rebuilds the run from retained history and reports
lost events explicitly; a finished run is read once from Router's archive. Closed or expired interactions
are disabled. When an Agent hands its browser to the owner, the live view opens beside the conversation.

The build-version watcher reloads an outdated page only when it is idle: never during a pending change,
an open dialog or form, or while an input has focus.

## Settings

The main navigation has one **设置** entry. It opens a modal over the app with a left navigation: 通用 (language,
theme, avatars), 连接器, 消息渠道, 身份与配对, 扩展, 数据控制 (clear a chat's history through Router's ledger purge),
帮助与法律 and 退出 (the edge login's logout). An Agent's own state and configuration are on its profile in the
people panel. 扩展 lists Skills, MCP, kernel plugins, Hooks, Tools and CLI as not connected: Agents install and use
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
opening from the Access session, Agent creation, pause and resume, channel connection, checks,
destruction, settings and connectors, conversations, groups, attachments, run details and approvals,
language switching, sign-out and an expired session. CI sets `MAU_WEB_E2E=1` so a missing build fails
rather than skips. Cloud lifecycle, Host, Access and channels are fixtures; QR scanning, a real Access
login, channel authorization and model replies need deployment-specific acceptance.
