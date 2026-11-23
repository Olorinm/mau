# Restricted background review adapter

`CodexRestrictedMemoryReviewer` implements actual review submission, lookup and cancellation using Router's public `WorkSessions`. `MemoryReviewCoordinator` performs cadence, context capture, deduplication and recovery. The default Mau configuration has no restricted runtime binding and reports `unsupported`; providing a prompt or enabling a boolean does not start a background model.

The current audited baseline for `codexReviewProfile()` is Codex **0.171.0**, model **gpt-5.4**, a dedicated Responses provider, and the bundled model catalog. Existing **0.165.0** installations remain supported with their original catalog and policy IDs. The launcher must attest `bundled-0.171.0` or `bundled-0.165.0` to match the binary actually launched. This profile uses Codex's official [temporary structured request configuration](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/tui/src/temporary_structured_request.rs#L49-L145). It selects no execution environments, workspace roots or capability roots; disables kernel tool features and inherited context-file loading; and retains only trusted, server-dispatched memory tools. A read-only sandbox by itself is insufficient.

The adapter rejects different native versions, model or thread settings, custom `model_catalog_json` / provider `model_catalog_url`, enabled MCP servers, OAuth model-discovery paths, and API-key model discovery. The old `remote_models` feature is removed in this Codex version and is not used as a safety guarantee. Changing this baseline requires new native validation, not merely updating a version string.

## Provisioning and connection

1. Use [the Host CLI profile](../examples/restricted-review-host.json) and [dedicated provider configuration](../examples/restricted-review-provider.toml) as templates. The generated JSON uses the public Host `command`, `args` and `env` fields. It intentionally exposes no caller `allowedSettings`; the model is frozen in `thread.model`. Create private review HOME, CODEX_HOME, workspace and Host-state directories. Do not reuse a partner's HOME, workspace, MCP configuration or model catalog. No example contains an account or credential.
2. Provision a separate Router review worker/runtime through the existing embedding APIs. Its owner must match the source partner. A separate worker may have a different agent ID, but its trusted memory dispatcher must bind to the **original partner's** memory. The adapter refuses a binding that points to the worker's own memory instead.
3. Install a server-side dispatch allowlist. Only managed memory operations and explicitly provided native-managed skill operations may execute; all other product and channel tools are denied. Label memory writes as review-origin in every state, including submission, cancellation and uncertain outcomes; destructive operations must stage for owner approval. Do not derive this label from model text or only from a `running` status. A submitted source transcript is untrusted evidence, never authorization.
4. Implement the trusted `resolve(scope, signal)` dependency from the launcher's actual installed configuration and live dispatcher. Return `ReviewRuntimeBinding`: authenticated original partner scope, the review `WorkSessions`, the installed profile, its `reviewProfileDigest()`, dedicated-home and bundled-catalog evidence, and the dispatch policy. The resolver is an in-process trusted service boundary; it is not an HTTP endpoint accepting an attestation supplied by a user or model. It must invalidate its evidence when the launched configuration, catalog or dispatcher changes.
5. Construct `new CodexRestrictedMemoryReviewer({ resolve })` and supply it as `createMau`'s trusted `reviewer` dependency. The adapter itself checks the native version through `discover()` and the effective provider/MCP configuration through the read-only `config/read` native method. Each submission is checked again. It calls `WorkSessions.submit` with stable event/session IDs, delegation provenance, empty connector/business grants, a tool-call limit and an expiry. It never forks, delivers, or sends a follow-up message.

This adapter does not provision the worker or assert that an arbitrary existing runtime is restricted. The launcher's installed-profile and dispatcher evidence remains a required integration responsibility. `lookup` and `cancel` remain available after policy revocation so that an uncertain or running review can be reconciled safely.

## Skills boundary

The default binding must use `skills: { mode: "unavailable" }`; capabilities then report `skills: false`. Codex's `skills/config/write` enables or disables a discovered skill; it is not a general skill-content authoring API. This change adds no parallel skill filesystem manager. A trusted integration may advertise `native-managed` skills only when an actual scoped skill dispatcher exists, with exactly its tool names in the dispatch allowlist. Merely naming a tool `skill_manage` is not evidence that such a dispatcher exists.

## Native audit evidence

Each row describes a separate execution. The scripted provider ran on loopback and saw the catalog the real binary presented on every request. Each eight-scenario run used one synthetic memory read and seven empty-argument checks for unavailable tools. All seven returned a native unsupported-call result. Only the memory read reached the application dispatcher.

| Audit | Official Codex CLI | Scenarios | Local provider requests | Advertised tool | Reviewer capability |
| --- | --- | ---: | ---: | --- | --- |
| Original audit recorded before the upgrade | 0.165.0 | 10 | 18 | `memory_probe` | available |
| New release audit | 0.171.0 | 8 | 16 | `memory_probe` | available |
| Compatibility rerun on the updated adapter | 0.165.0 | 8 | 16 | `memory_probe` | available |

The original audit also checked configuration parsing and a managed run through the public Host HTTP service. Its ten scenarios belong to that earlier procedure. The checked-in audit runs eight independent Host sessions on either supported version. It checks the installed version and matching bundled catalog, the effective dedicated Responses provider and MCP configuration, every model-facing tool catalog, and the result and dispatch count of each call. The application's separate automated suites cover the coordinator and adapter with 14 and nine tests respectively. [Coordinator tests](../test/memory-review.test.ts) · [Adapter tests](../test/restricted-memory-reviewer.test.ts)

### Reproduce the eight-scenario audit

Use Node 24, a POSIX environment, and a checkout with Mau's pinned component archives, root dependencies and `web` dependencies installed. The script starts the pinned public Host CLI from `web/node_modules`. Use an absolute path to an official Codex executable of the version being checked. The checker takes no account credentials. It creates private temporary directories for the worker's home, state and workspace, starts a local Responses fixture and removes its state on exit. [Audit script](../scripts/audit-restricted-reviewer.mjs)

```sh
npm run build
node scripts/audit-restricted-reviewer.mjs /absolute/path/to/codex-0.171.0 0.171.0
node scripts/audit-restricted-reviewer.mjs /absolute/path/to/codex-0.165.0 0.165.0
```

A passing run prints one summary line and exits with status zero. The expected counts for 0.171.0 are shown below. The compatibility run prints the same counts with `0.165.0` in the version field.

```json
{"version":"0.171.0","scenarios":8,"providerRequests":16,"advertisedTools":["memory_probe"],"managedCalls":1,"nativeRefusals":7,"capabilities":"available"}
```

The evidence covers native protocol behavior and product dispatch in this dedicated configuration. Cloud deployment, external model quality and OAuth use require separate evidence. The checked-in files contain the deterministic fixture and these aggregate results.
