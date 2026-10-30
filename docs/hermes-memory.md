# Bounded employee memory

Mau adopts Hermes' curated two-file memory design. This replaces the previous keyword-ranked product facts; it does not replace the native Codex execution loop, skills, or native memory APIs. Upstream version and behavior checks are recorded in [the source audit](hermes-memory-source.md). License attribution ships in [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES).

## Files and session snapshots

Each owner/employee has a private memory directory under the Mau state directory, containing `MEMORY.md` (2,200 Unicode characters) and `USER.md` (1,375 characters). The first stores durable working knowledge; the second stores user preferences. Credentials, temporary task state and full conversation logs do not belong in either file.

New owner/delegated sessions receive both entire files, capacity usage and maintenance instructions through Host's stable instructions field (Codex's developer instructions). There is no fact scoring, vector database or retrieval step. Writes update persistent files immediately. The current conversation keeps its original snapshot; a new conversation gets current files. Forks inherit original instructions. Deploying changed tool definitions or stable instructions requires a one-time switch to a new execution mapping for each affected conversation. Existing native sessions and their history remain stored. Scheduled turns use the current read-only view described below without changing stable instructions or tool definitions.

The `employee_memory` tool supports `read`, `add`, `replace`, `remove`, and atomic `batch` operations. Writes must fit within the fixed limits. Full stores return actionable errors so the employee can consolidate existing entries; Mau does not silently summarize or discard entries. Ambiguous replacements and duplicate entries are rejected. Files and directory permissions, atomic replacement, cross-process serialization, and versioned write approvals protect consistency.

The content scanner detects specified injection/credential/control-character patterns on writes and reads. It is defense in depth, not a guarantee that every hostile sentence will be detected. Memory is context, never new account or tool permission.

## Approval and API

`nativeWork.memory.writeApproval` defaults to `false`. Set it to `true` to stage tool writes for the owner. The authenticated API exposes pending changes and approve/discard operations. Approval applies only to the exact proposed change and original file version; a stale approval cannot silently overwrite newer memory. Unattended review replacements/removals are staged even when ordinary autonomous writes are enabled.

`GET /agents/:id/memory` reads both files; `POST` executes a memory operation, for example:

```json
{"action":"add","target":"user","content":"Prefer concise Chinese reports."}
```

`GET /agents/:id/memory/pending` lists pending changes. `POST /agents/:id/memory/pending/:pendingId/approve` and `/discard` accept `{}`. All routes require ownership of the employee.

## Original history search

`session_search` and `POST /agents/:id/memory/search` use SQLite FTS5 trigram retrieval; short queries use escaped literal SQLite matching. Results are original excerpts, with session/source identity, offsets and explicit truncation. No model summary replaces the source text.

The index contains completed turns observed by this Mau version and native-history pages explicitly imported through `POST /agents/:id/memory/history/import` with `{sessionId,cursor?}`. Continue with the returned cursor to import more pages. It does not claim to have automatically indexed every historical Codex conversation. Native history remains authoritative and is read through Router's public owner-scoped interface. Search itself does not wake the Host.

## Background review boundary

Normal owner turns enqueue review bookkeeping without awaiting model work. Memory reminders become due after 10 completed owner turns; skill reminders require a trustworthy kernel tool-iteration count (template interval 15). Mau does not substitute tool-call count for model iteration count. Current Host completion receipts do not supply that count, so skill cadence is not automatically inferred.

The review coordinator supports durable trigger identities, copied native history, independent sessions, cancellation, scoped capability validation and unknown-outcome reconciliation. It requires a trusted `RestrictedMemoryReviewer` adapter supplied by the embedding service, backed by a dedicated runtime that denies all tools except managed memory/skill operations. It never treats an ordinary native fork or a prompt instruction as proof of isolation.

Mau provides `CodexRestrictedMemoryReviewer`, `codexReviewProfile` and `reviewProfileDigest` through its public package. The adapter verifies a separately provisioned worker, installed profile, owner/employee tool mapping, effective MCP configuration and the audited Codex version before using Router’s normal submit/lookup/cancel operations. Its audited baseline pins Codex 0.165.0 and gpt-5.4 with a dedicated Responses provider and bundled model catalog; the ordinary OAuth catalog path is not automatically accepted. Changing the kernel, model or profile requires a new isolation audit. Managed skill review remains unavailable unless the worker has a real scoped skill dispatcher. See [the reviewer adapter and deployment contract](restricted-memory-reviewer.md) for configuration and evidence.

The current default Mau composition has **no configured dedicated reviewer worker and tool binding**. Its API reports `unsupported / restricted_review_runtime_required`; it does not launch a broadly privileged background Agent. Foreground memory maintenance and reminders work independently. `GET /agents/:id/memory/reviews` reports this distinction; `POST /agents/:id/memory/reviews/state` with `{enabled:false|true}` controls future review work but cannot create missing runtime capability. Provisioning the dedicated worker and binding its managed tools is a deployment requirement. The adapter and coordinator tests do not represent a live deployed reviewer.

## Scheduled read-only memory

Every new scheduled Agent execution reads the latest `MEMORY.md` and `USER.md` for its owner/employee. It applies the same content screening and capacity checks as conversation snapshots. The task uses this current view for its preferences and knowledge even when the reused session contains an older conversation snapshot. Memory never grants access to additional accounts or tools.

The complete view is carried in native `toolOutput.output.scheduledMemory`, alongside the original source, task message and skill references. It contains `mode:"read_only"`, screened `text`, `createdAt`, a combined `revision`, and per-file revisions, usage and screening results. The Host request's `context.scheduledMemory` contains only that metadata, avoiding a second copy of the memory text. Scheduled text turns without `toolOutput` carry the complete view in `context` instead.

Mau saves this view with the first request before contacting Host. Retrying the same `requestKey`, including after a restart or lost response, reuses the exact saved input and does not read the files again. The next event has a new key and reads current files. This applies to fresh task sessions, reused task sessions and existing owner conversations. Their stable instructions, native session identity and tool catalog remain unchanged; this update requires no session rotation.

Scheduled work has no managed memory read/write tools and does not trigger review. Calls to those tools remain denied even if a reused owner conversation has them in its frozen catalog. The user's conversation can update memory; the next scheduled execution observes the saved update. Fixed-message reminders do not run an Agent or read memory. Background-review approval rules above are unchanged. These are Mau product policies, not a claim that Hermes cron never reads memory.

## Verification boundary

Unit and protocol/independent-package tests verify these contracts. They do not prove real model learning quality, complete prompt-injection protection, a deployed restricted reviewer, cloud wakeups or third-party notification delivery. No production rules, credentials or conversations are changed by the implementation tests.
