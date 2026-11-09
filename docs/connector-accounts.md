# Connector account management in Mau

Mau's **Connectors** page composes the public Agent Connectors account-management API. It supports listing the current owner's configured accounts, starting provider consent, checking authorization, and disconnecting. The existing business read tools and communication channel controls remain available independently.

Optional per-Agent assignments also expose a stable `connected_apps` read tool through Host's native tool protocol. The page shows assigned Agents before consent. Assignment alone does not authorize a provider account; provider consent and matching owner/Agent/connection assignment are both required. Writes and proactive execution are not enabled by this integration. An OAuth check is not proof that every product API works.

## Operator configuration

Configure Agent Connectors using its production security and account setup documentation. It can run separately, or Mau can compose its public `startConfigured` API using `runtimeConfigFile`. Production encryption supports Google Cloud KMS or a separate Cloudflare Worker Secrets wrapping service; the latter is not non-exportable KMS. Both require encrypted application files restored only into private Linux tmpfs. Development-file mode is not a production shortcut. The existing Cloudflare business read broker is a different service and cannot be used as this endpoint.

Add the following optional block to Mau's private options file (all values are examples):

```json
{
  "connectorAccounts": {
    "url": "http://127.0.0.1:18100",
    "issuer": "https://router.example.test",
    "audience": "agent-connectors",
    "authorityKeyFile": "private/connectors-authority.jwk.json",
    "consentOrigins": ["https://accounts.google.com"],
    "runtimeConfigFile": "private/connectors.json"
  },
  "connectedApps": {
    "url": "http://127.0.0.1:18100",
    "issuer": "https://router.example.test",
    "audience": "agent-connectors",
    "callerKeyFile": "private/connectors-caller.jwk.json",
    "assignments": [{
      "agentId": "00000000-0000-4000-8000-000000000001",
      "owner": "@alice:router.example.test",
      "connections": ["alice-gmail"]
    }]
  }
}
```

- `url` is the fixed service origin. HTTPS is required except for literal loopback addresses. Redirects, URL credentials, query strings and path prefixes are refused.
- `issuer` and `audience` must match the ConnectorService trust configuration. Use the authority private JWK generated through the component's public issuer API/CLI, with a `kid`, in a private file (0600); install only its public key in ConnectorService. Never use the caller key or mount this key in an Agent environment.
- `consentOrigins` must contain the exact HTTPS origins used by the configured providers. Approve these from provider configuration, not from an arbitrary model-supplied URL. Mau only returns a consent link from an explicit connect action; it never exposes it in the inventory.
- Configure each connection's `owner` as the exact authenticated Router account ID. Mau filters the service-wide inventory and checks ownership again before every management action. Coordinate ownership/configuration changes between services; do not reassign connection IDs while an operation is in flight.
- With `runtimeConfigFile`, the service must listen on `127.0.0.1` at the configured port. Set its `oauthRedirectUrl` to the public Mau origin plus `/oauth/callback`. Mau binds the single-use provider state to an HttpOnly, SameSite=Lax browser cookie, accepts the callback through the public component API, then redirects to its Connectors page. Never log callback queries. `/mcp` and management routes remain loopback-only. A separately hosted service must supply its own browser binding and return flow.
- The browser sends its owner bearer token when starting consent. It saves only the scoped browser-binding cookie and its existing Mau session; OAuth credentials remain in the connector service.
- Start with explicit read-only provider scopes for the first live check. Do not inherit a provider's broad defaults without reviewing them. Existing Muse, ChatGPT or Codex authorizations are not transferable to Mau.

Without this block the API reports `configured: false`; the UI shows setup is required and has no fake consent button. No KMS, provider application or account authorization is provisioned by adding the frontend.

### Google application setup

Create/select the application's Google Cloud project, enable the required API, configure Google Auth Platform branding/audience/data access, then create a **Web application** OAuth client with the exact ConnectorService callback URI. Store its downloaded client configuration in the service's encrypted application-file store, outside source control. The first Gmail acceptance should request only `https://www.googleapis.com/auth/gmail.readonly`. See Google's [web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server) and [consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent).

For a personal pilot, add the owner as a test user. Gmail authorizations in an External/Testing application expire after seven days, including offline refresh credentials; do not present this as a durable unattended deployment. Review the appropriate production or personal-use path before long-running automation. Public use of restricted scopes has separate verification requirements and exceptions. See [app audience rules](https://support.google.com/cloud/answer/15549945?hl=en) and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). Do not automatically publish the app or accept new terms as part of a local code test.

### Connector CLIs and guides in the Agent's environment

When `runtimeConfigFile` is set, Mau brings each Agent's connectors into its environment before a run (at most every ten
minutes per environment):

- For every assigned connection whose connector ships a guide (`@olorinm/agent-connectors/guides`) and currently offers
  the guide's CLI tools (`<connection>__gws_read`, `<connection>__cli_read`, `<connection>__agent_browser_read`), the guide is written as a Codex skill
  under `/home/user/.codex/skills/<name>/SKILL.md`. Codex lists installed skills with their one-line description, so the
  Agent knows the connector from the first turn.
- The guide's command (`gws`, `lark-cli`) is installed in `/usr/local/bin` as a two-line script that runs Agent Host's
  `agent-host-relay`. The Agent types the official CLI's commands; Agent Host relays them, bound to the running shell
  command, through the run's `connected_apps` tool. Credentials stay in ConnectorService, writes keep their approval
  cards, and scheduled or delegated runs stay read-only.
- For a browser connection the command is `agent-browser`: a small Node client Mau installs in `/usr/local/bin` that
  talks to the same Agent Host relay. It passes the agent-browser arguments and the shell's directory, retries
  `upload` on `agent_browser_write` (the owner approves the files and the current site), and prints the paths of saved
  files. Mau reads upload files from the workspace (below the working directory, at most 10 MB in total) and asks the
  browser for the current origin; screenshots, PDFs and downloads are saved under `browser_downloads/` in the working
  directory. Handoff stays a `connected_apps` operation (`handoff_start`), whose live view only the owner receives.
- Files Mau installs carry an `Installed by Mau` marker; unassigned ones are removed. Files without the marker (an
  owner's own skill or CLI) are never overwritten. Environments whose Agent Host predates the relay client get guides
  but no commands.

The Mau image includes the official Google Workspace CLI release (`/opt/gws/gws`, `AGENT_CONNECTORS_GWS_BINARY`), which
ConnectorService runs for `gws_read`/`gws_write`. The browser connector's agent-browser CLI comes with Agent Connectors'
npm dependencies; its install script is denied in `allowScripts` and is not needed.

## Product API

The following account routes require the authenticated owner's bearer session. No route accepts an owner, service endpoint, scope, tool name, grant, or signing key in its request body. The separate GET `/oauth/callback` accepts only provider state bound to the initiating browser and a code or cancellation; it returns a fixed local redirect and no credentials.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/_mau/v1/connector-accounts` | `configured` and sanitized accounts for this owner |
| POST | `/_mau/v1/connector-accounts/:id/connect` | Provider consent link or current status |
| POST | `/_mau/v1/connector-accounts/:id/check` | Current authorization status |
| POST | `/_mau/v1/connector-accounts/:id/disconnect` | Disconnect result |
| POST | `/_mau/v1/connector-accounts/:id/complete` | Feishu: finish the device-flow authorization; returns the consent link while it waits |
| POST | `/_mau/v1/connector-accounts/:id/feishu-application` | Feishu: body `{ "agentId" }`; hands that Agent's chat app to this connection (see below) |

POST bodies must be `{}`, except `feishu-application`. An unknown account and another owner's account both return 404. Responses use a small status vocabulary and allow-listed fields; raw upstream errors, credentials, arbitrary metadata and private keys are never forwarded. Management requests use fresh two-minute service tokens and do not retry automatically. The upstream response has a time and size bound.

A failed mutation can have already changed authorization or invalidated pending writes. Mau reports `connector_action_unknown`, leaves the outcome unresolved, and the UI requires a status check before another mutation. Checking state is not a retry. Disconnect clears local authorization and denies pending writes in ConnectorService; the provider grant may still need to be revoked in provider settings. Already dispatched writes are not cancelled by disconnect.

## Verification and remaining live acceptance

Repository tests use a local HTTP fixture with the component's real signature verifier. They cover owner isolation, refusal of extra request fields, consent destinations, response bounds, private-key permissions and mutations with unknown outcomes. The browser fixture covers consent, checking the callback result, disconnect confirmation and manual recovery after an unknown outcome. These are not live Google authorization tests.

Before enabling an account in production: deploy the secured service, configure the provider app and exact callback, complete owner consent, verify the OAuth grant, then exercise one narrow product API read through the assigned Agent. `connected_apps` uses a two-minute signed read-only caller token, checked by the service even for pre-approved writes. Mau admits it only on Router-authorized channel runs, persists that run admission and rechecks the configured Agent/owner at Host composition. The Agent never receives a signing key or provider token. Disconnection removes provider access; removing assignments takes effect after configuration reload/restart.

Adding this native tool to an existing Host session can require a controlled execution-session rotation. Preserve conversation history, run records and native files; do not repeatedly retry a tool-definition conflict or clear Router state. Background rules, granular user-editable assignment UI and write approvals remain separate work.

## Feishu: one entry for chat and personal access

Feishu is split by direction, on **one** Feishu app (like Feishu aily or Coze):

| | Owned by | Identity | What |
| --- | --- | --- | --- |
| 1 · 聊天 | Router chat channel | the app's bot | receive and send messages, cards |
| 2 · 个人权限 | Agent Connectors (`kind: "feishu"`, official `lark-cli`) | the owner (user authorization on the same app) | docs, calendar, drive, mail…; writes need the owner's approval |

The connectors page shows a single 飞书 card per Agent with both statuses (聊天已连接 / 个人权限 已授权 · 已过期 · 未授权):

1. **Chat** uses Router's existing flow (`registerApp` QR, `credentials.json` with `appId`, `appSecretFile`, `ownerOpenId`).
   The chat channel only carries messages; acting as the owner is the connector's job.
2. **Personal access**: Mau reads the chat channel's saved app (`credentials.json` and `app-secret` in Router's Agent
   directory) and hands it to the connector (`POST /v1/connections/:id/application`). No second app or app QR. Then
   `connect` starts the official device flow; the card shows the consent QR/link and polls `complete` until the owner
   confirms. Handing over the same app again keeps the authorization, so 重新授权 always hands over and reconnects.
   The CLI refreshes tokens itself. The hand-over runs automatically right after the chat channel connects.

The hand-over requires the owner's Agent, a connection owned by that owner, and an assignment of that connection to
that Agent (`connectedApps.assignments`). The secret goes only to the connector service and never to the browser.

### Rule 1: personal access only in the owner's private conversation

Connections the service lists with `usage: "owner_private"` (Feishu), plus `connectedApps.ownerPrivateConnections` and
every `kind: "feishu"` connection of the composed runtime, are admitted by `connected_apps` only when the run is the
owner's private conversation. The check is in Mau's `connected_apps` admission (`src/owner-private.ts`), from Router's
own records, not from the Agent:

- Channel message (`owner` admission): Router's `isOwnerInput` must hold: direct scope from the owner's address, or the
  owner-main conversation. Router also admits the owner's turns in private groups (owner plus the owner's Agents) as
  `owner`; those are groups and are refused. Visitors and other senders are never `owner`.
- Owner-authenticated work events (Router work-events API, the web console): allowed unless the session contains a
  message that is not the owner's direct input (a group or visitor session).
- Schedules: allowed, read-only. Rules are created by the owner, and Router requires their target and conversation
  sessions to be owner conversations (`notification_requires_owner_conversation`); delivery goes only there.
- Delegated work and memory reviews: refused. Unknown usage (service unavailable): every connection is treated as
  owner-private (fail closed).

Elsewhere, `action: "tools"` lists them in `unavailableHere` and a call returns `connected_app_owner_private_only` with a
message for the requester. The installed `lark-cli` relay goes through the same check.

### Rule 2: expiry is visible

Connector status `expired` (with `reason`, e.g. `refresh_token_expired`) becomes `state: "expired"`; the page shows a
banner, the catalog row says 需要重新授权, and the card offers 重新授权. Tools stay listed: a call returns
`feishu_personal_authorization_required` with `state`, a message saying re-authorization is needed and the consent
link, which the Agent passes to the owner.

### Production configuration

Requires Agent Connectors 0.1.0-alpha.9 and Router 0.7.0-alpha.12 or later (the versions pinned in `components.json`).

1. `connectors.json` (runtime): a Feishu connection per owner whose `owner` is the exact Router account and whose
   `directory` is inside the encrypted `secretFiles` bundle, e.g.
   `{ "id": "<owner>-feishu", "kind": "feishu", "owner": "@owner:server", "settings": { "directory": "feishu/<owner>" } }`.
   No app files are needed; Mau hands them over.
2. Mau options: add the connection to the Agent's `connectedApps.assignments[].connections` (as for Gmail) and add
   `https://accounts.feishu.cn` (`https://accounts.larksuite.com` for Lark) to `connectorAccounts.consentOrigins`.
   Then open 飞书 → 个人权限 → 授权 once.

## Connector catalog

The web console groups applications by everyday work, files/knowledge and messaging. Search and Available/Connected filters operate on applications, not Agent records. An application detail shows the real connection state, its connect/check/disconnect actions and the Agents using it. Messaging details reuse Router's channel setup flow with the selected channel; deleted environments are omitted from the choices without modifying their records.

Gmail's first release displays read access, unavailable write actions and disabled background sync as status rows. These are not editable permission switches. Unconfigured applications are marked Coming soon and have no authorization button. Account connection status is distinct from successful business API execution. The catalog does not synthesize connected accounts, email addresses or background permissions.
