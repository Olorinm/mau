# Native work integration

Mau composes Router's public `WorkSessions` API and Host's native adapters. Codex remains responsible for its threads, turns, compaction, skills, memory pipeline and tool/approval semantics. Public Router work session IDs are routing IDs, not native Codex thread IDs.

## Configuration

The Mau setting `"nativeWork": {"employeeTools": true}` enables stable product tools for admitted owner/delegated work: `work_sessions`, `employee_memory`, `session_search`, and `proactive_work`. This setting defaults to false to avoid silently changing the tool definition fingerprint of existing native sessions. It does not create rules or authorize accounts. Existing sessions need a deliberate migration or a new independent work session when adding tools. Changing a connector account does not change the stable tool definitions.

Use [host-native-work.json](../examples/cloud/host-native-work.json) as the trusted Host profile for skills/memory management. The runtime `nativeAccess` allowlist is server-owned and defaults closed when omitted. A method being allowed does not mean the installed Codex supports it: memory endpoints are experimental and native errors are retained. This profile does not enable native memory generation. Enable it only after selecting and verifying the runtime's own native home and memory trust boundary. Private owner work and public group work must not share private memory merely because they use different thread IDs.

Host preserves server notifications in its native event stream. `nativeAccess.notifications` permits outbound client notifications; it is not an event subscription and is deliberately absent from this profile.

Skill files can be delivered through the existing environment profile `files` list and persisted with the employee's files. Codex discovers and loads them. The skills management API enables/disables only paths returned by a fresh native `skills/list`; arbitrary local file paths cannot become configuration writes. File updates and root selection remain trusted environment setup.

## Public product operations

All routes below are under `/_mau/v1`, require the Router owner's bearer identity, and recheck employee ownership. Native reads do not automatically wake sleeping environments; an explicit environment resume is separate. Router's session/event management routes remain available under its public communication API.

| Route | Behavior |
| --- | --- |
| `POST /agents/:id/native/discover` | Read current Host/runtime discovery. |
| `GET /agents/:id/native/skills` | List actual native skills. |
| `POST /agents/:id/native/skills` | `{path, enabled}` for an already discovered skill. |
| `GET /agents/:id/native/memory` | Native memory status, if the runtime exposes it. |
| `GET /agents/:id/work-sessions/:sessionId/memory` | Read native thread memory through its authenticated Host binding. |
| `POST /agents/:id/work-sessions/:sessionId/memory` | `{mode: "enabled" | "disabled"}` through the authenticated Host binding. |
| `GET/POST /agents/:id/memory` | Read both files / execute a bounded memory operation. |
| `POST /agents/:id/memory/search` | SQLite original-history search with explicit index coverage. |
| `POST /agents/:id/memory/history/import` | Import one page from this employee’s native history, using `{sessionId,cursor?}`. |
| `GET/POST /proactive` | List/create owner rules. |
| `GET/PUT /proactive/:id` | Read or replace with `{expectedVersion, rule}`. |
| `GET /proactive/:id/runs` | Cached run records and distinct notification receipts, without waking the Host. |
| `POST /proactive/:id/state` | `{status: "active" | "paused"}`. |
| `POST /proactive/:id/run` | `{requestId}` for a stable manual trigger. |
| `POST /proactive/:id/cancel` | Cancel the known active event; pausing alone does not cancel. |

The `work_sessions` tool supports list, native read/history, create/send, fork, rename, archive/unarchive, steer, wait and cancel. It chooses neither owner nor Host from model arguments. Wait observes Router state and does not hold the worker's dispatch loop. `employee_memory` maintains bounded MEMORY.md and USER.md files; it does not edit Codex-generated native memory. Scheduled Agent work receives a fresh screened read-only view per event, saved for identical retries, and cannot invoke memory tools. See [Hermes memory](hermes-memory.md) for snapshots, approval, history and background-review boundaries.

The `proactive_work` tool supports rule creation/update and inspection/pause/resume/manual run. Changes require an owner-admitted turn; delegated work may only inspect rules and run history. This prevents a short-lived or narrowed delegation from creating broader persistent background permission. Steering a running session also requires owner admission because it would otherwise use the target run's grant. New rules default to paused. An active rule requires explicit status and valid assigned accounts and must be requested by the user.

## Proactive rule contract

Rules contain `agentId`, `targetSessionId` (an existing owner private conversation), `name`, `goal`, `timeZone` (IANA), and `schedule`: either `{type:"interval",minutes:5..10080}` or `{type:"daily",at:"HH:MM"}`. Other fields are assigned `connections`, optional operation names and native skill references, notification mode (`changes`, `always`, `none`), optional quiet hours, `maxRunsPerDay`, `maxToolCalls`, `timeoutSeconds`, and status.

Scheduled and delegated work uses the native standalone tool-output delivery shape and retains the actual `mau` tool namespace/name. It is not a synthetic human instruction. Native tool outputs cannot be combined with `UserInput` skill items: scheduled skill references are validated against native discovery, then supplied by canonical name/path for native on-demand loading. This is not a guarantee of forced skill injection. Explicit user turns can use structured native skill input items through Router.

Daily schedules execute once per local date. A nonexistent DST wall time skips that date; a repeated time uses its first occurrence. Delayed intervals coalesce into one check. A rule has one active trigger, and hitting a budget does not mint replacement triggers. The triggering identity is derived from rule ID, version and scheduled occurrence; manual requests include the caller's stable request ID.

The coordinator lives in Mau's process, with a separate SQLite lease and records. It queues work through Router; Router wakes the configured Environment only for deliverable work. Execution selects a reused per-rule session, a fresh session per occurrence, or an existing conversation. Conversation work can wait for idle execution. Heartbeat is a preset, not another coordinator. A failed or lost submission is reconciled using the same event ID. Unknown execution outcomes remain held and queried, never automatically resubmitted under a new ID.

`execution: {type:"direct",message:"..."}` delivers a fixed reminder through the durable Router outbox without submitting an Agent run. `execution: {type:"agent"}` invokes the native Agent. Neither direct delivery nor a connector precheck needs to wake the Host. Session selection is `{type:"rule"}`, `{type:"fresh"}`, or `{type:"conversation",sessionId:"...",idleOnly:true}`. Notification mode remains independent of execution and session selection.

An explicit `preset:"heartbeat"` supplies a 30-minute interval, the owner conversation from `targetSessionId`, idle-only execution and changes-only notification. Explicit schedule/session/notification fields override that template. A regular task without a preset must provide a schedule.

An optional `precheck: {connectionId,tool,arguments}` calls an assigned read-only connector operation on the trusted server. Its successful result is canonically hashed; equal results skip the Agent, and the first result triggers a run. This only compares the configured query's returned data, not every change in the source. Errors never mean "unchanged". A new checkpoint is committed after successful work, not before execution. Lost precheck outcomes are explicit and do not mint replacement execution identities.

The model returns validated JSON. Each task prompt includes the JSON Schema generated from the same result validator, including string-valued finding versions. In Codex native Code Mode, Mau tool responses are JSON text: scripts must parse a string response before inspecting its `status` or `result`. The task prompt states that boundary explicitly; Mau does not change Codex's native return type. Source IDs must belong to the rule. Cursor proposals require a source-specific trusted connector receipt checked by the `ProactivePort.validateCursor` adapter; the model's JSON alone is never proof. Without that adapter, or if it rejects a proposal, the trigger records `cursorUpdates.status=unverified` and does not advance the cursor. The current product connectors do not supply that receipt adapter, so their cursor advancement is disabled. A verified cursor must also be a decimal monotonic value; opaque cursors are not supported by this initial adapter. Partial failures never advance source cursors. Completion, eligible cursor updates, finding deduplication and notification outbox creation share one transaction.

Notifications use Router's stable outbox identity and receipt query. Quiet hours defer them; user pause holds them. Authorization loss pauses the rule and produces one actionable notice per rule version unless notifications are disabled. Failed and uncertain delivery receipts remain distinct and do not create replacement messages. A `sent` record means Router received the provider's acceptance receipt, not that a person read it. External writes are not exposed by this workflow.

## Trusted grants

Router supplies `HostAdmission` through the embedding interface for owner, delegated or scheduled work. Mau consumes it before public Host HTTP submission. Tool names and model text do not establish authorization. Mau validates owner/employee, current rule state, expiry, call budget and connector operation intersection on every call. The stable tool catalog is retained for the native session and inherited by forks, while each child's calls use its own run grants. Revoked grants stop actual execution immediately. Persisted run requests restore grants after lost start responses and preserve the exact context on retries. Persisted call receipts prevent duplicate execution after worker recreation; ambiguous calls remain uncertain.

## Verification

`npm test`, `npm run typecheck`, and the independent package consumer test cover implementation and protocol fixtures. Proactive tests cover lost submission/restart, source isolation, missing and forged cursor proofs, cursor regression, atomic notifications, daily limits, overlap, cancellation during submission, pause, quiet hours, invalid authorization, and DST. These are distinct from real model, cloud wakeup, account access and provider delivery acceptance, which require separate evidence.

No dedicated restricted review runtime is provisioned by default, so background review reports `unsupported / restricted_review_runtime_required` even when its preference is enabled. External notification acceptance and any additional native capabilities require their own evidence.
