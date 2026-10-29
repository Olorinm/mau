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

## Product API

The following account routes require the authenticated owner's bearer session. No route accepts an owner, service endpoint, scope, tool name, grant, or signing key in its request body. The separate GET `/oauth/callback` accepts only provider state bound to the initiating browser and a code or cancellation; it returns a fixed local redirect and no credentials.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/_mau/v1/connector-accounts` | `configured` and sanitized accounts for this owner |
| POST | `/_mau/v1/connector-accounts/:id/connect` | Provider consent link or current status |
| POST | `/_mau/v1/connector-accounts/:id/check` | Current authorization status |
| POST | `/_mau/v1/connector-accounts/:id/disconnect` | Disconnect result |

POST bodies must be `{}`. An unknown account and another owner's account both return 404. Responses use a small status vocabulary and allow-listed fields; raw upstream errors, credentials, arbitrary metadata and private keys are never forwarded. Management requests use fresh two-minute service tokens and do not retry automatically. The upstream response has a time and size bound.

A failed mutation can have already changed authorization or invalidated pending writes. Mau reports `connector_action_unknown`, leaves the outcome unresolved, and the UI requires a status check before another mutation. Checking state is not a retry. Disconnect clears local authorization and denies pending writes in ConnectorService; the provider grant may still need to be revoked in provider settings. Already dispatched writes are not cancelled by disconnect.

## Verification and remaining live acceptance

Repository tests use a local HTTP fixture with the component's real signature verifier. They cover owner isolation, refusal of extra request fields, consent destinations, response bounds, private-key permissions and mutations with unknown outcomes. The browser fixture covers consent, checking the callback result, disconnect confirmation and manual recovery after an unknown outcome. These are not live Google authorization tests.

Before enabling an account in production: deploy the secured service, configure the provider app and exact callback, complete owner consent, verify the OAuth grant, then exercise one narrow product API read through the assigned Agent. `connected_apps` uses a two-minute signed read-only caller token, checked by the service even for pre-approved writes. Mau admits it only on Router-authorized channel runs, persists that run admission and rechecks the configured Agent/owner at Host composition. The Agent never receives a signing key or provider token. Disconnection removes provider access; removing assignments takes effect after configuration reload/restart.

Adding this native tool to an existing Host session can require a controlled execution-session rotation. Preserve conversation history, run records and native files; do not repeatedly retry a tool-definition conflict or clear Router state. Background rules, granular user-editable assignment UI and write approvals remain separate work.
