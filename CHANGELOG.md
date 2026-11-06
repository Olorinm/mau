# Changelog

Notable changes to Mau, newest first. Each version has a GitHub Release with the same notes and its
archives. When releasing, add the new section here in the version-bump commit; the Release notes are
copied from it.

## [0.1.0-alpha.23] - 2026-11-05

- Owner ledger, phases 1–2 (Router 0.7.0-alpha.10). Every channel is also written to a ledger that
  Router owns, and existing Matrix history can be backfilled into it. A read-only history API and
  event socket serve the web console when `AGENT_LEDGER_READ=1` is set; Matrix stays the default.
  Router's ledger socket is attached to Mau's HTTP upgrade handler.
- Employee deletion treats environments whose provider was removed, or that the provider reports as
  missing, as already deleted. It no longer rebuilds the runtime it is deleting, and it logs
  unexpected errors. Start failures print their cause.
- Pins Host 0.1.0-alpha.14.

PRs: [#21](https://github.com/Olorinm/mau/pull/21), [#25](https://github.com/Olorinm/mau/pull/25), [#26](https://github.com/Olorinm/mau/pull/26)

## [0.1.0-alpha.22] - 2026-11-05

- Connector CLIs and guides inside the Agent's environment. Before a run, Mau installs each
  assigned connector's guide as a Codex skill, and its CLI (`gws`, `lark-cli`) as a command. The
  command is relayed through Agent Host to the run's `connected_apps` tool and bound to the shell
  command that is running. Credentials stay in the connector service; writes still need an
  approval card.
- The image ships the official Google Workspace CLI 0.22.5.
- Pins Host 0.1.0-alpha.13 and Connectors 0.1.0-alpha.8.

PR: [#24](https://github.com/Olorinm/mau/pull/24)

## [0.1.0-alpha.21] - 2026-11-05

- Web console requests send same-origin cookies, so a Cloudflare Access gate in front of the
  console lets its API calls through. An API redirect is reported as an expired access session
  instead of a network error. Web only.

PR: [#23](https://github.com/Olorinm/mau/pull/23)

## [0.1.0-alpha.20] - 2026-11-05

- Removed business data: the `business_data` tool, the `/connectors` inventory and check
  endpoints, the console's 业务数据 entry and the `businessTools` configuration. Older sessions
  whose tool list still names `business_data` get an immediate `tool_removed` result.
- `feishu_bot_read` stays, configured by `feishuBotReaders`.
- Pins Connectors 0.1.0-alpha.7.

PR: [#22](https://github.com/Olorinm/mau/pull/22)

## [0.1.0-alpha.19] - 2026-11-05

- Pins Connectors 0.1.0-alpha.6. Gmail tools match Google's Gmail MCP server (the same ten tools,
  inputs and descriptions). They return shaped messages (sender, recipients, decoded text and HTML
  bodies, attachment metadata) instead of raw Gmail API payloads.
- Adds the `html-to-text` and `nodemailer` dependencies. No Mau source change.

PR: [#20](https://github.com/Olorinm/mau/pull/20)

## [0.1.0-alpha.18] - 2026-11-05

- Delete employees with `DELETE /_mau/v1/agents/:id`, `mau delete NAME --yes`, or 删除员工 in the
  web console.
- Deletion destroys the employee's environments, deactivates its Matrix account (Router
  0.7.0-alpha.9), and removes its memory, schedules, channel connections and product records.
- It is refused while work or a scheduled run is in progress. Repeating a deletion that stopped
  partway finishes it.

PR: [#19](https://github.com/Olorinm/mau/pull/19)

## [0.1.0-alpha.17] - 2026-11-05

- Web console: the run footer only reports lost execution steps ("部分执行过程未能保留").
  Shortened long values are marked inline in the process, so the "部分过长的输出只保留了开头和结尾"
  footer is gone.

PR: [#18](https://github.com/Olorinm/mau/pull/18)

## [0.1.0-alpha.16] - 2026-11-05

- Web console: a conversation left open while a run finishes now shows the complete answer.
  Previously it continued from the Host's live position and kept only partially streamed text.
  Router serves finished runs from its archive, numbered from 1, and the console now rebuilds the
  finished run from the start.

PR: [#17](https://github.com/Olorinm/mau/pull/17)

## [0.1.0-alpha.15] - 2026-11-05

- Durable execution history. Pins Router 0.7.0-alpha.8, Host 0.1.0-alpha.12 and UI
  0.1.0-alpha.9.
  - Hosts keep completed native items, and Codex streaming deltas are live-only.
  - Router archives keep whole items, omit inline media, and report lost events separately from
    shortened values.
  - The console says which of the two happened ("部分执行过程未能保留" or
    "部分过长的输出只保留了开头和结尾"). Before, it always said earlier events were lost.
  - The console shows reasoning from completed items.

PR: [#16](https://github.com/Olorinm/mau/pull/16)

## [0.1.0-alpha.14] - 2026-11-05

- Web console: landing parameters from the OAuth callback are used only once, so reloading opens
  Conversations instead of Connectors. A toast reports connected, failed or cancelled.
- Conversations wait for their task list before painting. Finished runs read all event pages in one
  pass, are cached for reuse, and show their final state with a collapsed process row instead of a
  loading state.

PR: [#15](https://github.com/Olorinm/mau/pull/15)

## [0.1.0-alpha.13] - 2026-11-04

- Pins Connectors 0.1.0-alpha.5. A browser click that submits a form no longer fails with
  `connector_unexpected_error` while the page navigates, and unexpected browser errors are logged.
  No Mau source change.

PR: [#14](https://github.com/Olorinm/mau/pull/14)

## [0.1.0-alpha.12] - 2026-11-04

- Browser uploads send the bare MIME type. Text files (`text/plain; charset=utf-8`) now reach the
  owner's approval card instead of failing as `invalid_arguments`. Component pins are unchanged
  (Connectors 0.1.0-alpha.4).

PR: [#13](https://github.com/Olorinm/mau/pull/13)

## [0.1.0-alpha.11] - 2026-11-04

- Connector writes are approved through Router's approval cards. This applies only to runs started
  by the owner; scheduled and delegated runs stay read-only.
- Workspace relay for the Cloudflare Browser Run browser connector:
  - uploads from workspace paths, with symlinks contained to the sandbox;
  - downloads saved to `browser_downloads/`;
  - screenshots returned as images;
  - Live View handoffs delivered only to the owner.
- Pins Connectors 0.1.0-alpha.4.
- Includes the `follow-redirects` 1.16.2 security patch.

PR: [#12](https://github.com/Olorinm/mau/pull/12)

## [0.1.0-alpha.10] - 2026-10-30

- Hermes-style employee memory, plus one model for scheduled and heartbeat tasks.
- Native work coordination.
- Turns an employee starts on its own, such as background subagent results, are relayed to the
  owner's chat.
- OpenGrove-style web console:
  - 对话 and 通讯录 views;
  - one direct chat per employee;
  - groups with @mentions;
  - the run process shown in order;
  - history readable while the employee sleeps.
- Connector account management.
- Node 24.22.2 security upgrade.
- Pins Router 0.7.0-alpha.7, Host 0.1.0-alpha.11, UI/Frontend 0.1.0-alpha.8, Connectors
  0.1.0-alpha.3 and Environment 0.2.0-alpha.3.

PR: [#11](https://github.com/Olorinm/mau/pull/11)

## [0.1.0-alpha.9] - 2026-10-21

- Lifecycle for Cloudflare environments, and guarded migration between environments.
- Scoped reads of business and Feishu data.
- Component packages are pinned to exact, unchangeable versions.
- Web console for watching native runs, and a CLI you can install on its own.
- The server needs access to the private Environment component, which is derived from OMA. The CLI
  archive contains no server or private component code.

## [0.1.0-alpha.8] - 2026-10-16

Deployed, not published as a GitHub Release; included in 0.1.0-alpha.9.

- Web chat keeps the expanded run details open when the final Matrix reply arrives.

## [0.1.0-alpha.7] - 2026-10-16

Deployed, not published as a GitHub Release; included in 0.1.0-alpha.9.

- Web chat shows native runs with the original run UI, including native run watching and
  interactions.
- Streaming history is restored.
- Build version checks reload stale assets.
- Cancellation is shown once, from the native run state.

## [0.1.0-alpha.6] - 2026-10-14

- Feishu setup can recover an existing app without creating another bot or copying its App Secret:
  `mau channel-connect feishu --app-id cli_YOUR_EXISTING_APP_ID`. `mau channel-jobs` lists setup
  jobs.
- When Feishu setup fails, the console offers Recover connection and keeps the known App ID, region
  and personal-tool choices.
- Router keeps setup job history across restarts, reuses saved credentials when binding fails, and
  reports instructions for recovering.
- Bot messaging connects independently of personal-tool consent. Checks report Host, messaging and
  personal authorization separately.
- Pins Router 0.7.0-alpha.3.

## [0.1.0-alpha.5] - 2026-10-14

- Browser console:
  - Router/Matrix sign-in;
  - Agents and environment lifecycle;
  - channel connections and checks.

  It uses the separately released Agent UI 0.1.0-alpha.2. Set `MAU_WEB_ROOT` to the built
  `web/dist`; the repository Dockerfile builds and enables it.
- Includes the shared workspace backend that was deployed as 0.1.0-alpha.4: account ownership,
  explicit sharing between Agents, file APIs and choosing a workspace in the CLI.
- Environment 0.2.0-alpha.2 checks the storage mount before the private Host starts up.
- Router health endpoints still return JSON. Channel setup recovers from temporary network or
  server failures and from rate limiting.

## [0.1.0-alpha.4] - 2026-10-14

Deployed, not published as a GitHub Release; included in 0.1.0-alpha.5.

- Shared workspaces owned by accounts, connected to Mau environments.

## [0.1.0-alpha.3] - 2026-10-14

- `mau ssh NAME [-- COMMAND]` opens SSH into your own Agent environment.
  - It uses your Mau login, checks that you own the Agent, and connects native OpenSSH through the
    service's HTTPS endpoint.
  - Each connection uses a temporary client key and checks the environment's Host key.
  - A paused environment must be resumed first. An active SSH session blocks pause, destroy and
    idle suspension.
- Operators enable SSH for each environment profile and ship OpenSSH in their Host image (see
  `examples/cloud/Dockerfile.ssh`).

## [0.1.0-alpha.2] - 2026-10-14

- Combines Agent Router 0.7.0-alpha.2, Agent Host 0.1.0-alpha.9 and the OMA-based Agent
  Environment 0.2.0-alpha.1 through their public package APIs.
- Environment lifecycle coordination: optional pause when idle, wake on authorized work, and
  renewal that survives failures.
- CLI, plus product APIs scoped to the owner.
- A standalone CLI archive with no runtime dependencies is also published.

## [0.1.0-alpha.1] - 2026-10-13

- First alpha. It separates the product from its reusable Agent components.
  - Mau owns product setup, environment profiles, Host startup and environment lifecycle.
  - Router owns accounts, channels and task delivery. Its provisioning commands and routes were
    removed without compatibility aliases (Router PR #52).
  - Host keeps native execution and sessions. Environment stays a separate provider library.

## components-20261013 - 2026-10-13

This is not a product release. It holds the pinned component archives (Agent Router from Router PR
#52, and Agent Environment) used for Mau source builds and CI.
