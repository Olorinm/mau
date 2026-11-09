# Changelog

Notable changes to Mau, newest first. Each version has a GitHub Release with the same notes and its
archives. When releasing, add the new section here in the version-bump commit; the Release notes are
copied from it.

## [0.1.0-alpha.29] - 2026-11-09

- Browser connections use the official agent-browser CLI: Mau installs an `agent-browser` command and the connector's
  guide as a skill for Agents with a browser connection. The command relays through Agent Host like `gws` and
  `lark-cli`, passes its directory for upload paths, and retries `upload` on the approval-bound write tool.
- The browser relay follows the connector's new tools: upload files are read from the workspace by path (relative to
  the shell's directory) and the approved site is the browser's current origin; files from `screenshot`, `pdf` and
  `download` are saved under `browser_downloads/` with absolute paths in the result; screenshots are also attached as
  images. The handoff card shows the Agent's instructions and points to the live view's Done button.
- The image keeps only its platform's agent-browser binary.
- Pins Agent Connectors 0.1.0-alpha.10.

PR: [#42](https://github.com/Olorinm/mau/pull/42)

## [0.1.0-alpha.28] - 2026-11-06

- Pins Router 0.7.0-alpha.13: ordinary Feishu replies keep their conversation, and explicit group
  topics inherit the group's native context through a fork before continuing independently.

## [0.1.0-alpha.27] - 2026-11-06

- A reply no longer blanks or shows a second loading line when it finishes, and Router's streamed
  text stays on screen while the run loads.
- One working line from queued to running, always below what the reply has shown so far.
- Tool rows show their arguments on one line; input and output are in the expandable code block,
  with Codex dynamic tool results read from their content.
- Pins Agent UI 0.1.0-alpha.10 and Agent Frontend 0.1.0-alpha.10.

PR: [#40](https://github.com/Olorinm/mau/pull/40)

## [0.1.0-alpha.26] - 2026-11-06

- Pins Router 0.7.0-alpha.12 and Agent Connectors 0.1.0-alpha.9.
- One 飞书 entry on the connectors page: 聊天 (Router's chat channel, bot identity) and 个人权限 (Agent Connectors as the
  owner, through the official lark-cli) on the same Feishu app. Mau hands the chat app to the connector, so there is no
  second app or app QR; the owner then authorizes with the official device flow.
- Personal (owner-identity) connections are admitted by `connected_apps` only in the owner's private conversation:
  never in groups (including Router's private groups), for other senders or delegated work; owner-created schedules
  stay read-only. Elsewhere they are listed as unavailable and calls return `connected_app_owner_private_only`.
- Expired authorization is shown as 已过期 with a banner and 重新授权; tool results say 需要重新授权 with the link.
- Removed Router's Feishu personal tools, which Router 0.7.0-alpha.12 dropped: the CLI `channel-auth` command and
  `--messaging-only` flag, the `personalTools` option when connecting Feishu, the console's personal-tools checkbox and
  Router authorization row, and the `feishu_personal` check label. Feishu personal access is only the connector's.

PRs: [#36](https://github.com/Olorinm/mau/pull/36)

## [0.1.0-alpha.25] - 2026-11-06

- Chat controls live in the composer: in a DM, `/new` starts a new chat and `/clear` clears the
  history after a typed-name confirmation; the header has no control buttons.
- While a reply runs, the send button stops it, and text sent joins the running reply (or becomes
  the next message when the runtime cannot take it). Added text shows as an ordinary message.
- New-chat and notice lines are a centred grey line. Files in messages are cards with their kind,
  above the text; draft attachments are cards with a corner remove button.
- Replies following one from the same Agent drop the repeated avatar and name; the process summary
  has space before the reply.
- Chats named by a raw session key read as the channel; an Agent's work sessions are not listed.
- Pins Agent Frontend 0.1.0-alpha.9.

PR: [#37](https://github.com/Olorinm/mau/pull/37)

## [0.1.0-alpha.24] - 2026-11-06

- Web console on the Router owner ledger (Router 0.7.0-alpha.11), each part behind Router's flags:
  sending and withdrawing messages with channel badges in the merged owner chat; cards, 新对话,
  cancel and steer, and chat purge; attachments by button, paste or drop with inline images; native
  groups with members and mentions; and a 身份与配对 settings page for linked identities and pairing
  codes.
- Edge login: with an `edgeIdentity` configured, the console has no login page and requests carry no
  token; an unmapped account sees a full-page notice, and an expired session keeps unsent text.
  `/_mau/v1` and SSH use the same check, with an Origin check on unsafe requests.
- Matrix optional: with Router's Matrix off, the console loads no Matrix code and agents are
  created and deleted without Matrix; Mau refuses to start without an edge identity and the ledger.
  `mau login --edge` authenticates through Cloudflare Access service tokens.

PRs: [#28](https://github.com/Olorinm/mau/pull/28), [#29](https://github.com/Olorinm/mau/pull/29), [#30](https://github.com/Olorinm/mau/pull/30), [#31](https://github.com/Olorinm/mau/pull/31), [#32](https://github.com/Olorinm/mau/pull/32), [#34](https://github.com/Olorinm/mau/pull/34)

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

- Removed the `business_data` tool and its configuration. Older sessions that still list it get an
  immediate `tool_removed` result.
- Pins Connectors 0.1.0-alpha.7.

PR: [#22](https://github.com/Olorinm/mau/pull/22)

## [0.1.0-alpha.19] - 2026-11-05

- Pins Connectors 0.1.0-alpha.6. Gmail tools match Google's Gmail MCP server (the same ten tools,
  inputs and descriptions). They return shaped messages (sender, recipients, decoded text and HTML
  bodies, attachment metadata) instead of raw Gmail API payloads.
- No Mau source change.

PR: [#20](https://github.com/Olorinm/mau/pull/20)

## [0.1.0-alpha.18] - 2026-11-05

- Delete employees with `DELETE /_mau/v1/agents/:id`, `mau delete NAME --yes`, or the web console.
- Deletion destroys the employee's environments, deactivates its Matrix account (Router
  0.7.0-alpha.9), and removes its memory, schedules, channel connections and product records.
- It is refused while work or a scheduled run is in progress. Repeating a deletion that stopped
  partway finishes it.

PR: [#19](https://github.com/Olorinm/mau/pull/19)

## [0.1.0-alpha.17] - 2026-11-05

- Web console: the run footer only appears when execution steps were lost. Shortened long values
  are marked inline in the process instead.

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
  - The console says which of the two happened, instead of always saying earlier events were
    lost.
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

- Employee memory, plus one model for scheduled and heartbeat tasks.
- Native work coordination.
- Turns an employee starts on its own, such as background subagent results, are relayed to the
  owner's chat.
- Web console:
  - Chats and Contacts views;
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
- Scoped Feishu reads.
- Component packages are pinned to exact, unchangeable versions.
- Web console for watching native runs, and a CLI you can install on its own.
- The server needs the private Environment component. The CLI archive contains no server or
  private component code.

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

- Combines Agent Router 0.7.0-alpha.2, Agent Host 0.1.0-alpha.9 and Agent
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
