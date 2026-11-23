# Changelog

Notable changes to Mau, newest first. Each version has a GitHub Release with the same notes and its
archives. When releasing, add the new section here in the version-bump commit; the Release notes are
copied from it.

## [0.1.0-alpha.66] - 2026-11-24

- Collapse or reopen the desktop navigation with the Mau mark at the left edge. The console remembers the choice on this device.

- Deliver a partner's message as one JSON object: who sent it (`from.partner`), when (`sent`) and the message. The fixed lines around it are gone: the header, the sender's duty, the intent, the rules of the turn, the permission sentences that the `connected_apps` description already states, and both boundary lines. A Codex partner and a partner on a text-only kernel read the same object.
- Deliver results to their sender as one JSON object with `results`. `action=wait` returns the same members for a result; `sentTo` is now `requested: { kernel, model, effort }`, and `intent` is no longer part of a result.
- Say what a partner's message or a hand-over is once, in the `partners` tool's description, instead of in every message.
- Continue a partner's conversation in a new window, once and when nothing runs in it, when its session began with another description of the `partners` tool. This happens for every existing partner after the upgrade: the owner sees the divider of a new conversation in each partner's chat, the model starts that conversation without its earlier context, and the transcript, memory and files stay.
- Leave the `next` sentence out of the result of `recruit`, `message`, `wait` and `dismiss` where it repeated the description or the guide. It remains for what one call adds: a computer that is offline, a restored partner, a first message that was not sent.
- Tell an agent on the owner's computer why a partner's message arrives and where its answer goes, in the message's `about`, and carry earlier notes as `notes`. It is no longer told that the message grants no approval.
- Pin Agent Kit 0.11.0-alpha.16 for structured partner deliveries and idle owner-conversation resets.

## [0.1.0-alpha.65] - 2026-11-23

- Move desktop navigation to a left rail and open the app grid beside it. The phone layout keeps its bottom bar.
- Pin Agent Kit 0.11.0-alpha.15.

- Tell a turn the partner roster on its session's first turn and when it changes, instead of every turn. `partners` with `action=roster` returns it at any time.
- Keep Router's routing identifiers out of what a model reads beside its input.
- Deliver partner messages with Router's brief sender and permission notice. Paired computers apply their local approval rules to the delegated task.

## [0.1.0-alpha.64] - 2026-11-23

- Run Claude, Codex and Antigravity employees in one workspace with their own connector assignments and approval routing. DeepSeek Harness is available as another native runtime.
- Select official Lark and Google skills according to the workspace's connections. Keep the browser skill available for localhost pages and preserve user-authored skills when assignments change.
- Use gateway-held credentials for Git, GitHub CLI, Claude and DeepSeek. The sandbox browser can test local applications with Chromium.
- Pin Agent Kit 0.11.0-alpha.14 and include a repeatable native audit for the updated restricted memory reviewer.

## [0.1.0-alpha.63] - 2026-11-23

- Keep the conversation list beside the active chat on desktop, with last-message previews and unread indicators. On phones, the list, chat and partner profile each get their own screen.
- Open conversations, apps and account settings from the new navigation bar. Settings and profiles share the updated layout, and dialogs open as bottom sheets on phones.
- Browse apps from the deployment's app directory through `GET /_mau/v1/apps` and pin up to three in the navigation bar. Pins are saved in the current browser.
- Add a web app manifest and home-screen icons for the console.

## [0.1.0-alpha.62] - 2026-11-23

- Show Conversations and Create app in a single navigation list on desktop and mobile. Remove the App Store placeholder.
- Open Settings from the account menu, including from the mobile navigation drawer.

## [0.1.0-alpha.61] - 2026-11-22

- Import shared Codex credentials once at the environment gateway and keep real model sign-in files out of managed sandboxes.
- Refuse unrecognized credentials and require a paused environment before migrating existing model authentication.

## [0.1.0-alpha.60] - 2026-11-22

- Install managed skills with the workspace user's permissions and keep system command installation separate.
- Preserve binary browser uploads and receive downloads through private staging files.
- Isolate the SSH bridge and its credentials from the execution user while allowing OpenSSH to read authorized public keys.

## [0.1.0-alpha.59] - 2026-11-22

- Update production Hono to 4.13.19 and its Node adapter to 2.1.11.
- Pin Agent Kit 0.11.0-alpha.11 with Zod 4.6.7 in Agent Host.

## [0.1.0-alpha.58] - 2026-11-21

- Owners can edit a partner's name and duty in its console configuration, with `mau partner edit NAME`,
  or through `PATCH /_mau/v1/agents/:id`. Partners see the new name and duty in their roster and
  can address the same partner by its new name. Existing device pairings and conversations are preserved.
- Pins Agent Kit 0.11.0-alpha.10.

## [0.1.0-alpha.57] - 2026-11-19

- Pins Agent Kit 0.11.0-alpha.9.
- Partners on the owner's own computer. `mau partner create NAME --external` (or the third choice when creating a
  partner in the console) makes a partner that is an agent already installed on a computer of the owner. It prints a
  pairing code and the `agent-host link` command to run there; the computer's Host then connects to the service by
  itself and reconnects after either side restarts. Mau sends such a partner messages, shows its replies and passes
  its approvals to the owner, and nothing else: its kernel, model, permissions, files and memory are the computer's
  own, and it gets no tools, skills, memory, connections, schedules or environment from Mau (those routes answer
  `409 not_available_for_external_partner`). See `docs/external-agents.md`.
- `mau device list`, `mau device show NAME`, `mau device pair NAME` and `mau device remove NAME --yes`
  (`GET /_mau/v1/devices`, `GET`, `DELETE /_mau/v1/agents/:id/device`, `POST /_mau/v1/agents/:id/device/pair`): the
  paired computer of a partner, a new pairing code, and ending the pairing. A partner summary carries `kind`, and for
  a partner on a computer `ownership`, `connection` (`pairing`, `online`, `offline`) and `device`.
- A message to a partner whose computer is off or not yet paired is kept and delivered when it connects.
  `mau chat send` returns at once with `"state": "queued"` and `"waitingFor": "pairing" | "offline"`, and the console
  shows the same in the conversation.
- Other partners reach a partner on a computer with the `partners` tool (relay, ask, inform, wait); its answer returns
  to the conversation the message was sent from. An inform reaches it together with the next relay or ask.
- When the kernel of a partner asks for approval in a turn that another partner's message started, the request also
  appears as a card in the conversation that message was sent from; the owner's choice there is passed on, and the
  card is withdrawn when the request is answered elsewhere or expires. `wait` and the roster say that the message
  waits for the owner's approval.
- `mau deploy` lets the two host link paths through Cloudflare Access (`/_agent-router/v1/host-links/enroll` and
  `/_agent-router/v1/host-links/socket`; a pairing code or the device credential authenticates them), and
  `mau doctor` checks them. A deployment whose Access applications were created by hand needs the two Bypass
  applications added.

## [0.1.0-alpha.56] - 2026-11-19

- Pins Agent Kit 0.11.0-alpha.8.
- Access tokens: the owner gives an agent a scoped, expiring, revocable token (`mau token create NAME --scope …`,
  `mau token list`, `mau token revoke ID`; `GET`, `POST /_mau/v1/tokens`, `DELETE /_mau/v1/tokens/:id`). A token
  carries `chat`, `approve` and/or `manage`, expires within 90 days and is stored only as a digest. It is presented
  as the `Mau-Token` header (`--mau-token-file`, `MAU_TOKEN_FILE`, `MAU_TOKEN`) beside an Access service token of
  the same owner and lets that service token do what the scopes cover; it is no sign-in. What only the signed-in
  owner can do stays so: tokens themselves, purging a chat, identities, a connection's operation settings and a
  browser connection's site access. `mau whoami` shows the token in use.
- Every route in `GET /_mau/v1/reference` (`mau api`) has a `scope`. A refused request under `/_mau/v1` names the
  scope it needs.

## [0.1.0-alpha.55] - 2026-11-19

- Pins Agent Kit 0.11.0-alpha.7.
- The CLI is rewritten as `mau NOUN VERB NAME`: `partner`, `env`, `chat`, `card`, `memory`, `channel`, `connector`,
  plus `login`, `logout`, `whoami`, `profiles`, `ssh`, `api`, `deploy`, `doctor` and `local`. A partner is always
  named; there is no selected partner. The result is one JSON document on stdout; a failure is one JSON object on
  the last stderr line and exit code 1. The old commands (`setup`, `use`, `agents`, `status`, `check`,
  `environment-*`, `pause`, `resume`, `destroy`, `reconcile`, `channel-*`) and the `--allow-http` and `--token-file`
  options are removed. See [docs/cli.md](docs/cli.md).
- New from the CLI: chatting with a partner and waiting for its turn, stopping a turn, starting a new conversation,
  listing and answering cards, reading and changing memory, model settings, disconnecting a channel and replacing
  its allowlists, connector accounts with their policies and site access, and `mau api` for any route.
- `mau deploy --hostname HOSTNAME --owner-email EMAIL` deploys Mau to a Cloudflare account: buckets, the R2 key,
  the environment gateway, the Access applications, the configuration and the Worker. Each step first checks what
  exists, so the same command continues after a failure and upgrades a deployment. What the credentials cannot do
  is reported for the owner to do by hand (exit code 2). `mau doctor` checks a machine, a deployment and a running
  service and names a fix for every failed check. See [docs/deployment.md](docs/deployment.md).
- `mau local` runs Mau on one machine without Cloudflare: partner environments are Docker containers and the owner
  signs in with a local token. The server accepts that token only when `MAU_LOCAL_TOKEN_FILE` is set, it listens on
  a loopback address and no edge identity is configured. The web console signs in from the address `mau local`
  prints. See [docs/local.md](docs/local.md).
- The connections a partner may use are state, not configuration: `GET` and `PUT /_mau/v1/agents/:id/connectors`.
  `connectedApps.assignments` is removed from `mau.json`; assign again after upgrading
  (`mau connector assign ID NAME`). A change applies to a partner's next `connected_apps` call.
- `GET /_mau/v1/reference` lists every HTTP route of the service with its summary and request body schema; a test
  compares it with the routes the app registers.
- An environment profile may set `env`, passed to the environment when it is created.
- `examples/` is the configuration `mau deploy` and `mau local` generate from; the example profile is `codex`.

## [0.1.0-alpha.54] - 2026-11-19

- Pins Agent Kit 0.11.0-alpha.6. Approvals are decided only by a card button; a typed reply is an ordinary message.
  An Access service token is read-only under `/_mau/v1` and cannot open the SSH tunnel unless it has
  `"access": "owner"`.
- Connector approval cards show every argument in full; only file bytes are shown as a size, and invisible
  characters are made visible. An operation whose summary and arguments exceed 3500 characters is refused with
  `approval_too_long_to_display` before a card is shown, for run cards and partner approval cards.
  `card.display.partnerApproval.argumentsShortened` is removed.
- Scheduled rules an Agent creates, changes or enables through `proactive_work` wait for the owner: nothing is
  saved until the owner confirms a card in their conversation with the Agent that shows the schedule, the full
  instruction, the connections it may read and where results go. An existing rule keeps its saved version and state
  until then. Pausing, and rules saved through the owner API, take effect directly. Unanswered cards expire after
  three days.
- Every change of a partner's memory is recorded with its origin (the owner's own turn, a partner's message or
  results, or a memory review), keeping the last 100 per partner. Owner routes list the changes, mark them seen and
  undo one; an undo is refused with `memory_undo_conflict` when the memory has changed in that place since. The
  partner profile lists the changes that were not the owner's since the owner last looked, with their source and an
  undo.
- Browser connection: a setting to open new sites directly or always ask, and an always-allowed list with remove
  (`GET|PUT /_mau/v1/connector-accounts/:id/access`). When set to always ask, a new site shows a card in the owner's
  conversation (allow for this task / always allow / deny); the call waits and runs once allowed. Turns that cannot
  ask reach always-allowed sites only.
- Cloud environments are held to the ChatGPT account of the profile's Codex sign-in file (`modelAccounts`, sent on
  every create and resume). A profile can name the accounts or set `modelAccounts: false`. The environment gateway
  must be the one from Agent Kit 0.11.0-alpha.6 or later; an older gateway refuses the field.
- Cloudflare entry: `/health/live` is not recorded in the access log, a failed access record no longer fails the
  request, and at most 50,000 records wait in storage (oldest dropped).

## [0.1.0-alpha.53] - 2026-11-19

- The browser handoff card carries its live-view link in a structured field, the only place the console reads it
  from. The card text shows the link on its own line ahead of the Agent's note, names the host of the page handed
  over, and removes every link from the Agent's note.
- Pins Agent Kit 0.11.0-alpha.5: Feishu group chats admit the owner and listed senders only; Google Workspace CLI
  commands are classified by their method's HTTP verb, so `--dry-run` no longer makes a write a read.

## [0.1.0-alpha.52] - 2026-11-18

- Mau deploys on Cloudflare as one Worker with one container. [`cloudflare/`](cloudflare) holds the Worker, its
  Durable Object and the container's start script; [deployment](docs/deployment.md) describes it. The Durable
  Object keeps the container running, forwards requests and WebSockets, restarts the container for a new image,
  instance size or `CONFIG_REVISION`, and stops it while `RUN` is not `"true"`.
- The container's disk is empty at every start. Its start script reads configuration from one R2 bucket into
  `/config`, restores `/state` from another and keeps copying it back: SQLite databases with Litestream as they
  change, other files with rclone every 30 seconds. A stop that is asked for loses nothing committed; a start
  refuses to run on a failed restore or on a state bucket that lost its databases.
- `start.sh seed` copies an existing state directory to an empty state bucket, to move an installation in.
- The Durable Object keeps an access record of each request (time, method, path, status, duration, client
  address) in an R2 bucket, and can run Agent Environment's encrypted backup in the container once a day.
- The image starts through `cloudflare/container/start.sh` and sets `MAU_STATE=/state`,
  `AGENT_SERVICE_STATE=/state/router` and `MAU_CONFIG_FILE=/config/mau.json`; it adds Litestream, rclone,
  python3 and age. The Dockerfile now builds from a checkout: `.dockerignore` no longer leaves out files it copies.
- An idle Mau no longer writes its databases every second: a coordination lease its holder already has is
  written again only in its second half, and background memory review takes its lease only when there is work.
- CI checks the Worker, builds the image and runs it through a first start, a stop and restore, a kill, a lost
  replicator, a lost bucket and a seed (`cloudflare/test/container.sh`).
- Agent Kit 0.11.0-alpha.4.

## [0.1.0-alpha.51] - 2026-11-18

- An environment can offer more than one kernel. A profile's `otherKernels` lists kernels beside
  its main one (`codex`, `claude`), each a further runtime of the same Host in the same working
  directory, with that kernel's own private files. A profile without it is set up, bound and
  fingerprinted exactly as before, and adding a kernel later invalidates no binding or session.
  See [environments](docs/environments.md#more-than-one-kernel-in-an-environment).
- A recruit can name any kernel its roster lists. `roster` lists the kernels of the caller's
  environment and, for the ones other than its own, their models, efforts and default
  (`otherKernels`); `recruit` binds the new partner to the named kernel's runtime, checks model
  and effort against that kernel, carries nothing over from the recruiter to another kernel, and
  refuses a kernel that is not offered or whose runtime the Host does not have. Left out, the
  kernel is the recruiter's, as before. The `partners` tool definition is unchanged, so no
  session is invalidated. `POST /_mau/v1/agents` accepts `kernel` beside `shareWith`,
  `GET /_mau/v1/options` lists a profile's `kernels`, and an Agent summary has the `kernel` that
  Agent runs on.
- A partner on a kernel other than Codex works with the others like any partner: messages reach
  it as text behind Router's notice where its runtime takes no native tool output, results return
  the same way, and memory, the roster beside its input, schedules and approvals are the same.
  The connector commands in the shell work for Codex partners only and are no longer installed
  by other kernels' runs; such a partner uses `connected_apps`, whose catalog now carries the
  connectors' guides and how to run their commands through the tool. The relay of native
  wake-ups follows Codex runtimes only. See
  [partners on another kernel](docs/native-work.md#partners-on-another-kernel).
- A profile that offers other kernels tells the provider which model endpoints its kernels need
  (`openai` for `codex`, `anthropic` for `claude`) with every create and resume. A profile with
  one kernel sends the same requests as before.
- Chat events carry what a console shows as members instead of text to parse: a partner's
  message has `display.partnerMessage`, a hand-over `display.partnerResults`, and a partner's
  approval card `card.display.partnerApproval`. The console renders from them, words approval
  cards in the interface language, and shows an event without them as its whole text. The card's
  own text no longer repeats the partner's name in its title and its first line.
- `GET /_mau/v1/partners` returns `recruitedBy` as `{ id, name }`.
- Messages between partners that have ended, and finished hand-overs, are removed 30 days after
  they were created. `GET /_mau/v1/partners/messages` reads only the messages it returns.
- The console's new-partner dialog offers the kernels of the environment being shared, a
  partner's profile shows the kernel that partner runs on, and the settings pages no longer list
  dismissed partners under a connection or among the channels.
- Builds on Agent Kit 0.11.0-alpha.2: model endpoints selected per environment, and `display` on
  submitted work and owner requests.

## [0.1.0-alpha.50] - 2026-11-17

- An owner's partners work together through one tool, `partners`, which replaces `work_sessions`:
  `roster` lists the other partners and what a recruit may choose, `recruit` adds a partner in the
  recruiter's environment with a name and a duty, `message` sends text with an intent (`relay`
  and `ask` expect a reply, `inform` expects none and starts no turn), `wait` reads replies inside
  the turn for at most 60 seconds, and `dismiss` archives a partner; recruiting its name restores
  it. See [Partners](docs/native-work.md#partners).
- A message runs as a turn of the recipient's own conversation with the owner, recorded there
  with the sending partner as its sender. Its result returns to the conversation it was sent from
  as a turn of the sender, after the sending turn's answer is recorded, and that turn answers the
  owner on the connection the owner used. Results that are ready together share one turn, and a
  result read with `wait` in the sending turn is not delivered again.
- A message is not the owner's authorization: the recipient's turn may use what the sending turn
  could, within the connections assigned to the recipient. Connections that act as the owner's
  personal identity work only in a turn the owner started in a private conversation. When the
  recipient's connected-app write needs approval, the card appears in the sender's conversation
  and names the partner and the operation; refusal and timeout are final, and the card is
  withdrawn when the call or the turn ends.
- Limits: a turn that handles a message cannot recruit, message or dismiss; four messages of one
  sender may wait for replies; four generations of messages may follow one owner message; and
  partners are recruited, messaged and dismissed only from the owner's private conversation. A
  hand-over is retried eight times with growing delays, a result undelivered for 48 hours is
  dropped and stays readable, a message nobody answered for 48 hours fails, and after three
  wake-ups in a row for failures the owner gets a notice instead. Nothing is run again in a
  partner's place.
- Memory is one document per partner, `MEMORY.md` (4,000 characters), maintained with the
  `memory` tool (formerly `employee_memory`, without `target`). An existing `USER.md` is merged
  into `MEMORY.md` at start and removed; nothing is shortened.
- The setting `nativeWork.employeeTools` is now `nativeWork.partnerTools`; the former key is
  refused at start. A session keeps the tools and instructions it began with, so no existing
  session is invalidated; it sees `partners` and `memory` when its conversation starts a new
  window, and calls to the former tools there are answered with `tool_removed`.
- Owner API: `GET /_mau/v1/partners`, `GET /_mau/v1/partners/messages`,
  `POST /_mau/v1/agents/:id/dismiss` and `/restore`, `dismissed` in agent summaries, and
  `GET`/`POST /_mau/v1/agents/:id/memory` for the one document.
- Builds on Agent Kit 0.11.0-alpha.1: the owner conversation as a work target, turns that answer
  the owner, owner requests, the settlement feed and senders.
- The console shows what partners send each other as their own words. In the recipient's
  conversation a message stands under the sender's figure and name, and in the sender's
  conversation each result is a block of the partner that answered, with a line saying so when it
  did not complete; the lines written around them for the model are not shown, and text of another
  form is shown whole. A partner's figure or name there opens the conversation with it.
- A run's process shows each call of the `partners` tool as one line (recruited, passed on, asked,
  informed, waited, dismissed) whose partner name is a link, with what the partner was told
  beneath it; a refused call says why in a sentence.
- A partner's request for approval is a card under that partner's name in the conversation the
  message was sent from. It is answered once, and shows whether it was approved, declined,
  expired, withdrawn or answered elsewhere. A partner that waits for an approval says so in the
  list of conversations.
- Dismissed partners leave the header row and the list; a row at the end of the partners opens
  them, each with its restore. A profile's configuration dismisses and restores a partner, apart
  from deleting it.
- A profile names the partner that recruited it and the partner whose environment it runs in as
  lines of information that open that partner, and folds a duty longer than three lines. Its
  documents are `AGENTS.md` (read-only) and `MEMORY.md`.
- Refusals of the partners tool, of dismissing and of the memory document have sentences in
  Chinese and English, and the English console says partner throughout.

## [0.1.0-alpha.49] - 2026-11-17

- Agents are called partners. The console says partner where it said employee, and code, tests
  and documentation use the name. Tool names and descriptions, stored data, routes and settings
  keep their text, so sessions and deployments need no change.
- A partner can run in the environment of another partner of the same owner: the same sandbox,
  Host, runtime and working directory, with its own identity, conversations, memory, schedules
  and model settings. `POST /_mau/v1/agents` takes `shareWith` in place of `profileId` and makes
  no cloud request. Either form accepts an optional `duty`, one line saying what the partner is
  responsible for, fixed when it is created; a sharing partner's instructions end with its name
  and duty. Agent lists and details return `duty`, and `environment` carries `sharedFrom` or
  `sharedBy`. A sharing partner only reads the environment's state, and an environment is not
  destroyed or replaced, nor its partner deleted, while other partners run in it. Idle pause and
  wake count every partner in the environment. See
  [Partners sharing an environment](docs/environments.md#partners-sharing-an-environment).
- The console's new-partner dialog is one page, without tabs: name and duty, then an environment
  of its own (the default) or one shared with a partner that has its own. Environment profiles
  show their full name and kernel. A profile shows the duty under the partner's name. A sharing
  partner's profile names the partner whose environment it runs in and has no environment
  controls; that partner's profile lists the partners sharing its environment. Refusals about
  shared environments are shown as sentences naming the partners involved.

## [0.1.0-alpha.48] - 2026-11-13

- An employee's model and reasoning effort can be chosen on its profile (配置). The choices are
  the models the employee's kernel reports, limited to the values its runtime's
  `allowedSettings` permits, and each model lists the efforts it supports; nothing is selectable
  when the runtime allows no choice. The selection applies to every following turn of the
  employee on any channel. `GET` and `PUT /_mau/v1/agents/:id/model-settings` are the API; while
  the environment is not running the last reading of the kernel's list is used.
- Builds on Agent Kit 0.10.0-alpha.3: adding or changing a runtime's `allowedSettings` no longer
  breaks its existing sessions, and Router sends an agent's default settings with every turn.
  The release also carries Agent Kit's dependency updates.

## [0.1.0-alpha.47] - 2026-11-13

- An employee's memory file (`MEMORY.md`, `USER.md`) opens beside the conversation as one
  document in the Markdown editor, with a divider between its entries, instead of one block per
  entry. A divider typed at the end starts a new entry, deleting an entry's text removes it, and
  one Save writes the document. The stored file and the employee's memory tool are unchanged.
  The editor writes Markdown in its own style, so the first save may rewrite untouched entries
  (`-` lists become `*`); an entry that itself contains a divider is saved as two.
- The console's stylesheet is about a fifth smaller: 733 rules for classes that no source file
  can produce are removed. The remaining rules and their order are unchanged.

## [0.1.0-alpha.46] - 2026-11-13

- Built on Agent Kit 0.10.0-alpha.1, whose Router keeps one record of channel messages (its
  ledger) and has no ledger switches: the web API, cards, control, groups, identities and
  attachments are always served. `AGENT_LEDGER_READ`, `AGENT_LEDGER_SEND` and the other
  `AGENT_LEDGER_*` variables are no longer read and can be removed from a deployment; Mau no
  longer refuses to start without them. On first start each employee's store is migrated by
  Router; no step is required.
- The console no longer waits for Router to advertise features: sending, card answers, new chat
  and clear, groups, attachments and the identity page are always available.

## [0.1.0-alpha.45] - 2026-11-12

- Built on Agent Kit 0.9.0-alpha.1, whose Router has no Matrix: accounts and agents, channel
  connections, the owner ledger and task delivery to Agent Host. No configuration change is
  needed; `AGENT_MATRIX` and the homeserver settings are ignored, and a `matrix` connection left
  on an employee is ignored.
- Employee objects and `GET /web/me` features no longer carry a `matrix` member.

## [0.1.0-alpha.44] - 2026-11-12

- Owners sign in through the edge identity only. The Matrix account login, the `publicHomeserver`
  option, `mau login --user/--password-file/--edge` and `channel-connect matrix` are removed;
  `/info` no longer reports `matrix`. Mau always runs Router with its Matrix switch off and
  refuses to start without an edge identity and the ledger.
- The one-time migration of schedule rules to a notification target is removed.
- The console's component package (`web/ui`) contains only what the console uses: six entries
  (`.`, `./agent-host`, `./app`, `./app.css`, `./pages`, `./pages.css`) instead of 26, without the
  video player, merge editor and command menu dependencies. The console looks and behaves the same.
- Built on Agent Kit 0.8.0-alpha.2. `scripts/pin-kit.mjs` refreshes both lockfiles; the console
  takes Agent Host's types from the pinned archive.
- Documentation describes the current product; dated verification records are removed.

## [0.1.0-alpha.43] - 2026-11-12

- Built on one Agent Kit release (0.8.0-alpha.1), which carries Router, Host, Connectors and
  Environment. `components.json` pins that release: its version, source revision and the
  integrity of each archive. `node scripts/pin-kit.mjs <version>` moves to another release.
- `node scripts/bootstrap.mjs` needs no arguments and no GitHub sign-in: it downloads the pinned
  archives and Host's protocol fixture, checks their bytes and installs dependencies.
  `npm run verify:packages` needs no arguments either.
- Environment is Cloudflare only and no longer brings the Alibaba, Volcengine and Kubernetes
  client dependencies (96 fewer installed packages). No change to the Router, Host or Connectors
  runtime code.
- Browser uploads validate the workspace path and choose the media type in Mau.

## [0.1.0-alpha.42] - 2026-11-12

- An employee's profile has a documents section: `AGENTS.md` (the fixed instructions of its
  environment profile, read-only), `MEMORY.md` and `USER.md`. A document opens beside the
  conversation; the memory files are edited there in the file editor, entries separated by a line
  with only `§`, and take effect from the next new conversation.
- `GET /agents/:id/instructions` returns the fixed instructions of the employee's environment
  profile to its owner.
- A file opened from a message is a card beside the conversation again, at the same level as the
  conversation, as the handed-over browser is. The people panel on the left still floats.

## [0.1.0-alpha.41] - 2026-11-12

- An employee's profile is four sections behind a row of icons: status (the environment and
  self-check), message channels, capabilities (the connectors it may use) and configuration
  (kernel, environment profile, destroying the environment, deleting the employee). It uses the
  same components as the settings pages, and the panel is 400px wide for it.
- Removed from the profile: the message button, which did nothing; the second connect-channel
  button; the summary card, which could not be opened; the update time; and the capabilities page
  that only said it was not connected.

## [0.1.0-alpha.40] - 2026-11-12

- People are in one panel on the left: the list of all conversations, and an employee's profile,
  opened from the employee's row in the list or from the current employee's figure in the header.
  The profile card on the right and its header button are gone.
- The panel floats inside the conversation's card and no longer moves or narrows the conversation.
  A file opened from a message floats on the right in the same way. Pressing on the conversation,
  or Escape, puts the people panel away.

## [0.1.0-alpha.39] - 2026-11-12

- The list of all conversations opens inside the conversation's card, on its left, instead of as a
  separate card that pushes the conversation aside. On a phone it takes the whole card while open.
- An employee's profile, a file or the handed-over browser is a card beside the conversation
  again, as before 0.1.0-alpha.38.

## [0.1.0-alpha.38] - 2026-11-12

- The brand sits above the navigation and pages start at the top of the window; the empty row
  across the top is gone. It stays when the navigation is hidden or narrowed to icons.
- An employee's profile, a file or the handed-over browser opens inside the conversation's card
  instead of in a second card beside it.
- On a phone the profile's close button is no longer covered by the title bar.

## [0.1.0-alpha.37] - 2026-11-12

- Dialogs stand out in dark mode: the page behind them is dimmed more, confirmation dialogs
  included, and the dialog has a light edge.
- Dialog buttons are 36px tall, like the other controls.
- The message field no longer shows a blue box when it has focus.

## [0.1.0-alpha.36] - 2026-11-12

- Settings, confirmation and connector authorization dialogs use dark backgrounds in dark mode,
  including when the theme follows the system.
- Reduce bundled frontend styles by removing duplicate and unused component rules while preserving
  light-theme appearance and existing control sizes.

## [0.1.0-alpha.35] - 2026-11-11

- Web console: when an employee hands its browser to the owner, the live view opens in the card beside the
  conversation and is operated there; the header keeps a button to reopen it. The console's content security policy
  allows framing `https://live.browser.run` only.
- A file in a message opens in the card beside the conversation: images and text (Markdown rendered) are shown, other
  kinds and large files are offered as a download.
- Matrix is offered as a message channel again while Router has Matrix on; its sign-in page and chat screen stay
  removed.

PR: [#49](https://github.com/Olorinm/mau/pull/49)

## [0.1.0-alpha.34] - 2026-11-11

- Web console: the header row of the conversation page holds employees first, then groups. Sessions of other
  channels are in the full list only and join the row while one is being read. The conversation opened on arrival
  is a chat with an employee before any other channel's session.
- Clearing a chat's history uses one confirmation dialog for the `/clear` command and the data controls page.

PR: [#48](https://github.com/Olorinm/mau/pull/48)

## [0.1.0-alpha.33] - 2026-11-11

- Web console: the conversation page is one column. Its header is a row of employee figures; the current conversation
  shows its name and state, the others switch on a click, and an employee without a chat yet opens one. The rest are
  in a list card beside the conversation (employees, groups, other channels' sessions, search, new employee, new
  group). Clicking the current one again opens the employee's profile (environment, channels, self-check, delete) in a
  card on the right; on narrow screens it covers the conversation.
- The Contacts and Files navigation entries are removed; `?agent=<id>` opens the conversation with that employee.
- Employees are drawn as pixel animals; Settings → General can switch to the illustrated faces.
- The console signs in through the edge identity only. The Matrix sign-in page, the Matrix chat screen, Matrix group
  creation and the Matrix channel option are removed; a service without an edge identity shows that web sign-in is
  not available, and a Router without the ledger `history` feature shows that chat history is not available.
- Sessions of other channels are titled by employee and channel instead of their session key; work sessions stay
  hidden. A read-only conversation hides the composer. Messages and the composer share one centred width.
- Pin Agent UI 0.1.0-alpha.13 (pixel-art employee avatars).

PR: [#47](https://github.com/Olorinm/mau/pull/47)

## [0.1.0-alpha.32] - 2026-11-11

- Web console: the contacts page no longer goes blank when a channel kind has no label. Bark, web and room channels
  get labels, and a missing label falls back to the other language, then to the key, instead of throwing.
- Pin Agent UI 0.1.0-alpha.12 and Agent Frontend 0.1.0-alpha.12 (white panels on the grey app background again).

PR: [#46](https://github.com/Olorinm/mau/pull/46)

## [0.1.0-alpha.31] - 2026-11-09

- Connector operation permissions: `GET|PUT /_mau/v1/connector-accounts/:id/policy` and
  `POST /_mau/v1/connector-accounts/:id/policy/reset` let the owner set each operation of a connection to allow, ask or
  deny; the connector service enforces them. Writes set to allow run in the owner's conversations without a card;
  reads set to ask get the approval card. Scheduled and delegated work stays read-only, and operations set to ask are
  refused there with `owner_approval_unavailable_here`. The `connected_apps` tool definition is unchanged.
- `POST /_mau/v1/connector-accounts/:id/connect` accepts `{ "operations": [...] }` to add the scopes of grantable
  operations (incremental consent), mapped by the connector service.
- The account list adds `account: { email?, name? }` for connected accounts, and keeps `authorizationUrl` and
  `expiresAt` while consent is pending, so a reloaded page shows the Feishu QR again. The `permission: "read-only"`
  field of assigned accounts is removed.
- Pin Agent Connectors 0.1.0-alpha.11 (operation policy API).
- Web console settings: the main navigation's configuration entries become one Settings modal with General
  (language, theme), Connectors, Channels, Identity and pairing, Extensions, Data controls, Help and legal, and
  sign-out. Deep links `#/settings/<section>[/<item>]` survive a reload, an OAuth return reopens the page it started
  from, and on narrow screens the modal is full screen with the navigation as its first page.
- Connectors settings: search and Available/Connected filters over the configured applications (applications without
  an account are hidden); every connection starts with a consent dialog. An application page checks the connection on
  open and shows disconnect (an unknown outcome requires a new check), the authorized account, the Agents using it and
  per-operation permissions (allow, ask, deny) with confirmation before allowing a write, adding grantable operations
  and reset to defaults. A server without the policy API shows the current behaviour read-only.
- Channels settings list each Agent's chat channels and run Router's connect flows inside the modal; Feishu chat and
  Feishu personal access link to each other.
- The Feishu personal-access QR is drawn from the account's pending `authorizationUrl`, survives a reload and falls
  back to the authorize button after `expiresAt`.
- Data controls clear a chat's history through the existing ledger purge.
- The console uses the Agent UI design system (`@olorinm/agent-ui/app.css`); chat cards and run details use the compact
  density. The old connectors, Feishu entry and extensions screens are removed.
- Pin Agent UI 0.1.0-alpha.11 and Agent Frontend 0.1.0-alpha.11.

PRs: [#44](https://github.com/Olorinm/mau/pull/44), [#45](https://github.com/Olorinm/mau/pull/45)

## [0.1.0-alpha.30] - 2026-11-09

- Pins Router 0.7.0-alpha.14: a send-only Bark channel and owner notifications for web-only answers, questions and
  reminders.
- Proactive rules gain `notify.channel` (Router schedule notice targets): `web` keeps notices in the conversation, and
  a connection id delivers them on that channel or push service. New rules default to `web`; an edit without
  `notify` keeps the prior target, and a channel that is not registered is rejected (`proactive_notify_channel_not_found`).
  On start, rules saved before this field keep the connection their notices used (the target session's newest owner
  conversation) without a version change. A `web` receipt counts as sent; a channel without a conversation fails
  with `no_conversation_on_connection`.

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
