# Web console

[简体中文](web.zh-CN.md)

Mau composes layouts extracted from the original OpenGrove presentation source in `@olorinm/agent-frontend` with the
lower-level `@olorinm/agent-ui` components. The frontend package receives data,
React content and callbacks; it has no Mau, Router, Host, Environment, Matrix or
OpenGrove backend dependency. Mau owns authentication, routes, navigation,
requests, account messaging and environment/channel workflows in `web/src`.

The UI covers account sign-in, Agent creation and management, environment
lifecycle, channel connections and messages with owned Agents. Account messages
use the public Matrix client API and Router's existing delivery path. There is no direct kernel chat, wallet or
withdrawal feature. Apps, extensions and settings keep visible product-owned
entries with explicit “not connected yet” content where no integration exists.

The original navigation, conversation input/search, profile, appearance settings,
app forms and extension workspace are reused. Extension navigation retains Skills,
MCP, kernel plugins, Hooks, Tools and CLI. Unavailable operations are disabled.
The original form layout and optional sapling artwork are reused; Router account
credentials and session verification remain in Mau. Neither the frontend package
nor Mau implements OpenGrove Bridge compatibility endpoints.

`components.json` pins both UI archives. Bootstrap downloads the exact release
bytes and verifies them against `web/package-lock.json`. Agent UI is a peer of
Agent Frontend so translations and shared providers use one context instance.

## Develop

```sh
node scripts/bootstrap.mjs            # also installs web/ dependencies
MAU_CONFIG_FILE=/private/mau.json npm start
npm run dev:web                        # Vite on :5173, proxies /_mau and /_agent-router to :8790
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

The page's Content Security Policy allows connections only to the same origin and
the public homeserver (`publicHomeserver` in `mau.json`). That homeserver must
allow browser CORS on its client API, which Synapse does by default.

## Sessions

- Password sign-in follows `mau login`: `GET /_mau/v1/info`, Matrix
  `m.login.password`, then `GET /_mau/v1/account`. Sign-out revokes that device.
- Token sign-in verifies an existing access token. Sign-out forgets it but does not
  revoke it.
- The token is kept in the browser's `localStorage` (`mau.session`). Any `401`
  returns to sign-in.

## Channels

Router setup jobs are polled every two seconds, including after temporary network,
server or rate-limit errors. Errors show a retry button; missing or expired jobs
stop polling. Router's `qr` field is a terminal
drawing; the console renders its own QR code from the job's `https` link and
offers the same link to open. Jobs live ten minutes in Router memory; an expired or
unknown job asks the user to start again. Feishu personal-tool authorization uses
Router's status, begin and complete routes.

## Verify

```sh
npm run test:web
```

This builds the console, runs the connection-layer tests and drives Chromium
against a fixture Mau: password sign-in (including a rejected password), agent
creation, pause and resume, Matrix connection, checks, destruction, language
switching, sign-out and an expired session. CI sets `MAU_WEB_E2E=1` so a missing
build fails rather than skips. Cloud lifecycle, Matrix and channels are fixtures;
QR scanning, real Matrix sign-in and channel authorization need deployment-specific
acceptance.

## Recover an existing Feishu app

On Feishu connection failures, choose **Recover connection** and enter the original
App ID from the developer console. The console preserves known App ID, region and
personal-tool choices. The official consent page restores access to that app;
no App Secret is copied. Saved credentials are reused when only binding failed.
Failed setup jobs remain available after a Router restart. Bot messaging and
personal authorization are reported separately in checks.

## Message behavior

Environment bootstrap enables the owner's Matrix connection for built-in chat.
Host health alone does not verify message routing; live acceptance must send a
message through the web console and observe its Agent reply.

Mau displays joined account rooms involving its owned Agents. Starting a new
conversation waits for the initial room sync and selects an owned Agent explicitly;
a group containing another
participant is not silently reused for a direct conversation. Existing groups are
marked as groups with participant counts and sender identities. The product adapter
uses Matrix sync cursors and displays recent text/notice messages. A limited
history is marked as such. Other message kinds and older-history pagination are
not implemented in this first account-messaging integration.

A failed send preserves the draft and transaction ID. Retry reuses that ID to
avoid duplicate delivery; dismissing retry is an explicit user action. A server
acknowledgment confirms sending, while Agent replies appear only after sync.
The browser tests simulate Matrix and do not establish live model acceptance.

The Files navigation entry is explicitly unavailable. Shared workspace operations
remain available through the existing Mau API and CLI. This integration does not
assemble a replacement file application from the frontend package’s workbench
components.
