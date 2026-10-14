# Web console

[简体中文](web.zh-CN.md)

The Mau web console covers sign-in, agent creation, environment state and lifecycle,
channel connection and checks. It calls only the existing Mau (`/_mau/v1`) and
Router (`/_agent-router/v1`) routes, plus the public Matrix homeserver for password
sign-in and sign-out. Chat, model settings, credentials and files are not part of
this release.

UI components come from `@olorinm/agent-ui/app` ([Agent UI](https://github.com/Olorinm/agent-ui),
extracted from OpenGrove). Mau owns the connection layer (`web/src/api`), copy and
layout. `components.json` pins the Agent UI release; bootstrap downloads it and
verifies the bytes against `web/package-lock.json`.

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
API, so no CORS configuration is needed. Paths beginning with `/_` are never
answered with the page. The [Dockerfile](../Dockerfile) builds the console and sets
`MAU_WEB_ROOT=/app/web`.

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

Router setup jobs are polled every two seconds. Router's `qr` field is a terminal
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
