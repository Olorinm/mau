# Native work integration

Mau composes Router's public `WorkSessions` API and Host's native adapters. Codex remains responsible for its threads, turns, compaction, skills, memory pipeline and tool/approval semantics. Public Router work session IDs are routing IDs, not native Codex thread IDs.

## Configuration

The Mau setting `"nativeWork": {"partnerTools": true}` enables stable product tools for admitted owner turns and partner turns: `partners`, `memory`, `session_search`, and `proactive_work`. This setting defaults to false to avoid silently changing the tool definition fingerprint of existing native sessions. It does not create rules or authorize accounts. Changing a connector account does not change the stable tool definitions.

A session keeps the tools and the instructions it began with: Mau stores both per Host session and sends them unchanged with every later turn, so a change to the tool definitions never invalidates an existing session. Such a session does not see tools that were added later. It gets them when its conversation starts a new window ("new chat", `/new`), which opens a new Host session. A tool that was removed since (`work_sessions`, `employee_memory`, `business_data`) is still listed in a session that began with it; a call to it is answered at once with `tool_removed` and the advice to start a new conversation.

Use [host-native-work.json](../examples/cloud/host-native-work.json) as the trusted Host profile for skills/memory management. The runtime `nativeAccess` allowlist is server-owned and defaults closed when omitted. A method being allowed does not mean the installed Codex supports it: memory endpoints are experimental and native errors are retained. This profile does not enable native memory generation. Enable it only after selecting and verifying the runtime's own native home and memory trust boundary. Private owner work and public group work must not share private memory merely because they use different thread IDs.

Host preserves server notifications in its native event stream. `nativeAccess.notifications` permits outbound client notifications; it is not an event subscription and is deliberately absent from this profile.

Skill files can be delivered through the existing environment profile `files` list and persisted with the partner's files. Codex discovers and loads them. The skills management API enables/disables only paths returned by a fresh native `skills/list`; arbitrary local file paths cannot become configuration writes. File updates and root selection remain trusted environment setup.

## Public product operations

All routes below are under `/_mau/v1`, require the Router owner's bearer identity, and recheck partner ownership. Native reads do not automatically wake sleeping environments; an explicit environment resume is separate. Router's session/event management routes remain available under its public communication API.

| Route | Behavior |
| --- | --- |
| `POST /agents/:id/native/discover` | Read current Host/runtime discovery. |
| `GET /agents/:id/native/skills` | List actual native skills. |
| `POST /agents/:id/native/skills` | `{path, enabled}` for an already discovered skill. |
| `GET /agents/:id/native/memory` | Native memory status, if the runtime exposes it. |
| `GET /agents/:id/model-settings` | The models and efforts the kernel reports and the runtime's `allowedSettings` permit, with the owner's choice. Read from the running kernel; while the environment is not running, the last reading is returned (`source: "saved"`). |
| `PUT /agents/:id/model-settings` | `{model?, effort?}`, each a listed value or `null` for the runtime's default. Router sends the choice with every following turn of the partner. |
| `GET /agents/:id/work-sessions/:sessionId/memory` | Read native thread memory through its authenticated Host binding. |
| `POST /agents/:id/work-sessions/:sessionId/memory` | `{mode: "enabled" | "disabled"}` through the authenticated Host binding. |
| `GET/POST /agents/:id/memory` | Read the memory document / execute a bounded memory operation. |
| `POST /agents/:id/memory/search` | SQLite original-history search with explicit index coverage. |
| `POST /agents/:id/memory/history/import` | Import one page from this partner’s native history, using `{sessionId,cursor?}`. |
| `GET /partners` | The owner's partners: `id`, `name`, `duty`, `kernel`, `model`, `effort`, `status`, `lastActivityAt`, `waiting: { messages, approvals }`, and where they apply `sharesEnvironmentOf`, `recruitedBy`, `recruitedAt`, `dismissedAt`. |
| `GET /partners/messages` | Messages between the owner's partners, newest first (`?agentId=` for one partner, `?limit=`): `from`, `to`, `intent`, `text`, `status`, `connectionId`, and when known `ran`, `result`, `deliveredBy`, `reason`. |
| `POST /agents/:id/dismiss`, `/restore` | `{}`. Archive a partner, or bring it back. `GET /agents` and `/agents/:id` return `dismissed` (a time, or `null`). |
| `GET/POST /proactive` | List/create owner rules. |
| `GET/PUT /proactive/:id` | Read or replace with `{expectedVersion, rule}`. |
| `GET /proactive/:id/runs` | Cached run records and distinct notification receipts, without waking the Host. |
| `POST /proactive/:id/state` | `{status: "active" | "paused"}`. |
| `POST /proactive/:id/run` | `{requestId}` for a stable manual trigger. |
| `POST /proactive/:id/cancel` | Cancel the known active event; pausing alone does not cancel. |

`memory` maintains the partner's one bounded MEMORY.md; it does not edit Codex-generated native memory. Scheduled Agent work receives a fresh screened read-only view per event, saved for identical retries, and cannot invoke memory tools. See [Hermes memory](hermes-memory.md) for snapshots, approval, history and background-review boundaries.

The `proactive_work` tool supports rule creation/update and inspection/pause/resume/manual run. Changes require an owner-admitted turn; a partner turn may only inspect rules and run history, so that a message between partners cannot create persistent background permission. New rules default to paused. An active rule requires explicit status and valid assigned accounts and must be requested by the user.

## Partners

A partner is an Agent of the owner: its own Router identity, its own conversation with the owner, its own memory and model settings, and one line saying what it is responsible for (its duty). The `partners` tool lets a partner work with the owner's other partners. It is not a sub-agent mechanism: a kernel's own sub-agents stay helpers inside one turn and are not managed here.

| Action | Behavior |
| --- | --- |
| `roster` | The owner's other partners (name, duty, kernel, model, effort, status, last activity, what waits at each), the caller's messages that wait for replies, what a recruit may choose (`kernels`, `models` with their efforts, `efforts`, and the caller's own settings), the limits, and the guide. `includeDismissed` also lists dismissed partners. |
| `recruit` | `name` and `duty`, optionally `kernel`, `model`, `effort`, and a first `message` with `intent`. The new partner runs in the recruiter's environment (the one the recruiter shares, when it shares one) and needs no approval. Values left out are the recruiter's own. Only values the roster lists are accepted; anything else is refused with the allowed values (`partner_kernel_not_available`, `partner_model_not_available`, `partner_effort_not_available`), never replaced by a default. `kernel` accepts the recruiter's own kernel only. A name that exists is refused (`partner_name_taken`), unless that partner was dismissed: then it is restored. |
| `message` | `to`, `text`, `intent`. `relay` passes on what the owner asked for, `ask` is the sender's own question; both expect a reply. `inform` expects none and starts no turn anywhere: the recipient reads it at the start of its next turn. A partner whose environment a message cannot wake (paused, being deleted, in need of attention, or missing) is refused at once with `partner_unavailable`. |
| `wait` | Waits up to 60 seconds (default 30) for replies, to the caller's waiting messages or to `messageIds`. A reply the turn that sent the message reads this way is not delivered a second time, once the answer of the `wait` call has reached that turn; if it did not (the call timed out at the Host), the reply comes back as a turn. A result stays readable by its id afterwards, and reading the result of an earlier turn's message does not stop its delivery. While a `wait` runs, a stop request for that turn takes effect when the `wait` returns. |
| `dismiss` | Archives a partner: its Agent, conversation and memory are kept, it leaves the roster, and it is not messaged. Recruiting its name restores it. Only a turn the owner started may dismiss. |

**Where a message runs.** A `relay` or `ask` is a turn of the recipient's own conversation with the owner (Router's owner conversation, opened if the owner has not written there yet), submitted with the sender as its `sender`. The context therefore stays in the recipient's long-lived conversation, and the owner finds the message, marked as sent by the other partner, and the answer in the recipient's chat. The recipient cannot ask the owner in that turn: its questions are not presented, and it is told to answer with what is missing so that the sender asks the owner.

**How the reply returns.** When the recipient's turn ends, Mau submits a turn to the conversation the message was sent from, with Router's `reply` on the connection the owner used there, so the sender's answer reaches the owner on the web or the channel the owner wrote on. The turn's input says that the system delivered it, that the owner did not write it and that it gives no new authorization, and carries for each result the partner, the original message, the status, the duration, the kernel, model and effort the partner's turn was submitted with, and the answer marked as the partner's own report, between two lines that carry a value chosen after the answer was written. Results that are ready together reach their sender in one turn (at most eight). A result is handed over only when the turn that sent its message has ended and that turn's answer is recorded in the conversation, so the result stands after it.

**Authorization.** A message is not the owner's authorization. The recipient's turn is admitted as a delegation whose grants are what the sending turn could use within the connections assigned to the recipient; whether connected-app writes can ask the owner follows the sending turn. The turn that hands results over acts within what the turns that sent those messages could use. Connections that act as the owner's personal identity are outside all of this: they work only in a turn the owner started in the owner's private conversation with a partner, and are refused in a turn that handles a partner's message and in a turn that hands a result over (`connected_app_owner_private_only`). When one is needed, the owner asks that partner directly in its own conversation. See [connector approvals](connector-accounts.md#approvals-for-a-partners-turn).

**Limits.**

- One layer: a turn that handles a partner's message can read the roster, and cannot recruit, message or dismiss (`partner_layer_limit`).
- A sender may have four messages waiting for replies. A further one is refused, not queued (`partner_message_limit_reached`). An `inform` is not counted; twenty of them may wait for one partner's next turn (`partner_note_limit_reached`).
- A turn that hands results over may send messages again. Four such generations may follow one message of the owner; the next is refused until the owner writes (`partner_chain_limit`).
- Partners are recruited, messaged and dismissed only from the owner's private conversation with the caller, because that is where a reply returns. Other owner turns (a group of the owner and the owner's Agents, work submitted through Router's work-events API) can read the roster; the rest is refused with `partner_owner_conversation_required`.
- A message is at most 16,000 bytes. An answer longer than the room one Router input has is cut in the hand-over and says so; the full answer is in the recipient's conversation.

**Delivery.** The record of every message is kept in Mau's store (`partner_messages`), with what became of it:

| Status | Meaning |
| --- | --- |
| `queued` | An `inform` that its recipient's next turn will carry. `seen` once a completed turn carried it. |
| `sending`, `running` | Recorded, then in the recipient's work queue until that turn ends. A send interrupted between the two is finished by the delivery loop. |
| `settled` | The result is known and waits for its sender. |
| `returning`, `returned` | Handed over in a turn of the sender, or, for a sender no longer woken, in a notice. |
| `collected` | Read by the sender with `wait`, or refused at once when the message could not be sent. |
| `dropped` | Never handed over. The result stays readable (`wait` with its id, `GET /partners/messages`). |

- The endings of turns are read from Router's settlement feed with a cursor per Agent, so a restart of Mau or of Router loses nothing. Every 15 seconds the open turns are also read from their work events: a turn that ended without an entry in the feed is settled from there, and a turn whose outcome has been unknown for two minutes (Router finds a run again by itself after an interrupted submission) is reported to the sender as `unknown`. Nothing is run again in the partner's place.
- A message whose recipient has not ended its turn after 48 hours fails with `no_answer_after_48_hours`, and that turn is cancelled.
- A hand-over that fails (the turn could not be submitted, or failed) is tried again after 5 s, 15 s, 1 min, 5 min, 15 min, 1 h and 3 h: eight attempts in all, then the result is `dropped`. Waiting for the sending turn to end is not an attempt, and a turn submitted to a busy conversation waits in Router's queue behind the running one. A turn the owner stopped is not repeated.
- A result that could not be handed over for 48 hours is `dropped`, and so is one whose hand-over turn has not ended after 48 hours; that turn is cancelled.
- A sender is woken at most three times in a row for results that all failed. After that a failure leaves a notice in the owner's conversation instead of a turn, until that partner sends a message in a turn the owner started, or a result succeeds.
- A failed or rejected result is final for its message: Mau does not retry the partner's work, run it elsewhere or answer in its place.

**What a turn is shown.** Every turn in the owner's private conversation, the owner's own and one that hands results over, is given the current roster (name, duty, status) and what the partner waits for, beside its input (Codex: `additionalContext`), when its session has the `partners` tool; it and a turn that handles a message are given the `inform` notes left for the partner. At most 30 partners are named there; the roster action lists all of them. The memory reminder is given the same way, to a session that has the `memory` tool. This is not part of the tool definitions or the session's instructions, so it is always current and changes no session fingerprint. How to use the tool is said in three places that belong to the tool and to no kernel: its description (rules that always hold), the guide in the roster, and the `next` of each `recruit`, `message`, `wait` and `dismiss` result.

Deleting a partner removes the messages it sent and the finished ones it received. A message another partner still waits on ends as `failed` (`partner_deleted`).

## Proactive rule contract

Rules contain `agentId`, `targetSessionId` (an existing owner private conversation), `name`, `goal`, `timeZone` (IANA), and `schedule`: either `{type:"interval",minutes:5..10080}` or `{type:"daily",at:"HH:MM"}`. Other fields are assigned `connections`, optional operation names and native skill references, notification mode (`changes`, `always`, `none`), optional quiet hours, `maxRunsPerDay`, `maxToolCalls`, `timeoutSeconds`, and status.

Scheduled work and partner turns use Router's delivery for input that no human wrote: the native standalone tool output for a kernel that takes one (`mau.proactive_work` for a schedule; `mau.partners` for a partner turn in a session that has that tool, Router's `mau.work_sessions` in a session that began before it), and text behind Router's fixed notice for a kernel that does not. It is not a synthetic human instruction, and Mau records it as such whichever form it took. Native tool outputs cannot be combined with `UserInput` skill items: scheduled skill references are validated against native discovery, then supplied by canonical name/path for native on-demand loading. This is not a guarantee of forced skill injection. Explicit user turns can use structured native skill input items through Router.

Daily schedules execute once per local date. A nonexistent DST wall time skips that date; a repeated time uses its first occurrence. Delayed intervals coalesce into one check. A rule has one active trigger, and hitting a budget does not mint replacement triggers. The triggering identity is derived from rule ID, version and scheduled occurrence; manual requests include the caller's stable request ID.

The coordinator lives in Mau's process, with a separate SQLite lease and records. It queues work through Router; Router wakes the configured Environment only for deliverable work. Execution selects a reused per-rule session, a fresh session per occurrence, or an existing conversation. Conversation work can wait for idle execution. Heartbeat is a preset, not another coordinator. A failed or lost submission is reconciled using the same event ID. Unknown execution outcomes remain held and queried, never automatically resubmitted under a new ID.

`execution: {type:"direct",message:"..."}` delivers a fixed reminder through the durable Router outbox without submitting an Agent run. `execution: {type:"agent"}` invokes the native Agent. Neither direct delivery nor a connector precheck needs to wake the Host. Session selection is `{type:"rule"}`, `{type:"fresh"}`, or `{type:"conversation",sessionId:"...",idleOnly:true}`. Notification mode remains independent of execution and session selection.

An explicit `preset:"heartbeat"` supplies a 30-minute interval, the owner conversation from `targetSessionId`, idle-only execution and changes-only notification. Explicit schedule/session/notification fields override that template. A regular task without a preset must provide a schedule.

An optional `precheck: {connectionId,tool,arguments}` calls an assigned read-only connector operation on the trusted server. Its successful result is canonically hashed; equal results skip the Agent, and the first result triggers a run. This only compares the configured query's returned data, not every change in the source. Errors never mean "unchanged". A new checkpoint is committed after successful work, not before execution. Lost precheck outcomes are explicit and do not mint replacement execution identities.

The model returns validated JSON. Each task prompt includes the JSON Schema generated from the same result validator, including string-valued finding versions. In Codex native Code Mode, Mau tool responses are JSON text: scripts must parse a string response before inspecting its `status` or `result`. The task prompt states that boundary explicitly; Mau does not change Codex's native return type. Source IDs must belong to the rule. Cursor proposals require a source-specific trusted connector receipt checked by the `ProactivePort.validateCursor` adapter; the model's JSON alone is never proof. Without that adapter, or if it rejects a proposal, the trigger records `cursorUpdates.status=unverified` and does not advance the cursor. The current product connectors do not supply that receipt adapter, so their cursor advancement is disabled. A verified cursor must also be a decimal monotonic value; opaque cursors are not supported by this initial adapter. Partial failures never advance source cursors. Completion, eligible cursor updates, finding deduplication and notification outbox creation share one transaction.

Notifications use Router's stable outbox identity and receipt query. Quiet hours defer them; user pause holds them. Authorization loss pauses the rule and produces one actionable notice per rule version unless notifications are disabled. Failed and uncertain delivery receipts remain distinct and do not create replacement messages. A `sent` record means Router received the provider's acceptance receipt, not that a person read it. External writes are not exposed by this workflow.

## Trusted grants

Router supplies `HostAdmission` through the embedding interface for owner turns, partner turns and scheduled work. Mau consumes it before public Host HTTP submission. Tool names and model text do not establish authorization. Mau validates owner/partner, current rule state, expiry, call budget and connector operation intersection on every call. The stable tool catalog is retained for the native session and inherited by forks, while each child's calls use its own run grants. Revoked grants stop actual execution immediately. Persisted run requests restore grants after lost start responses and preserve the exact context on retries. Persisted call receipts prevent duplicate execution after worker recreation; ambiguous calls remain uncertain.

## Trusted read tools

Optional `feishuBotReaders` entries in the server configuration select an exact
`agentId` and `owner` with a Feishu bot identity (`appId`, `appSecretFile`, `domain`,
`directory`), or a Cloudflare read broker (`mode: "cloudflare"`, `endpoint`,
`tokenFile`). Mau exposes `feishu_bot_read` through Host's native dynamic tools,
running the official CLI outside the Agent environment. Only CLI-declared reads
whose dry-run plans are read-only may execute. Shell access, identity overrides and
local file paths are not accepted.

The tool is provided only to conversations admitted by Router's channel policy;
unadmitted runs and other Agents receive no grant. The Feishu bot's permissions
still define which records can be read. This is not a per-person authorization
system. Configure channel access accordingly.

The reader reuses existing credentials from private server files. It does not
deploy an OAuth vault or KMS. Personal Feishu authorization and writes require the
separate ConnectorService flow. Model authentication is also separate from this
reader and may still be present in the sandbox.

## Verification

`npm test`, `npm run typecheck`, and the independent package consumer test cover implementation and protocol fixtures. The partner tests run real Router runtimes against a scripted Host: recruiting, the three intents, the reply's way back, restarts, the delivery limits and the approval card in the sender's conversation. The package consumer runs a recruit, a message read with `wait` and a reply returned as a turn through a real Host process. None of this shows how a model uses the tool, or delivery on an external channel. Proactive tests cover lost submission/restart, source isolation, missing and forged cursor proofs, cursor regression, atomic notifications, daily limits, overlap, cancellation during submission, pause, quiet hours, invalid authorization, and DST. These are distinct from real model, cloud wakeup, account access and provider delivery acceptance, which require separate evidence.

No dedicated restricted review runtime is provisioned by default, so background review reports `unsupported / restricted_review_runtime_required` even when its preference is enabled. External notification acceptance and any additional native capabilities require their own evidence.
