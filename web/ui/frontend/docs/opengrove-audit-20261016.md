# OpenGrove frontend extraction audit — 2026-10-16

Reference: `open-grove/opengrove@8b365ed2babc6caccc588cab1fa2d08488fb67a7`, the extraction baseline. The original checkout was used read-only. The accompanying [file inventory](opengrove-source-inventory.json) assigns all 115 baseline component TSX files to a destination or a reason for exclusion; shared primitives in `agent-ui/src` are counted there, not reimplemented inside the page package.

## What went wrong

The previous extraction preserved many outer layouts and styles but did not extract all of their child views. Slots were used in place of some missing concrete views. A source-manifest entry was incorrectly treated as evidence of completeness. Earlier visual tests covered selected states rather than every frontend surface.

The missing original execution renderer was then replaced by a new 77-line `AgentProcess`. Mau wrapped status, process and answer together inside the reply bubble. This changed both the presentation and the integration despite the original implementation already existing. Historical events were also loaded in a loop before the first state became visible. The browser lacked the original application's build-version checking behavior, so existing tabs could retain old assets. The latter is a confirmed missing mechanism, but is not proof of the precise cause of the user's earlier screenshot.

## Boundary

Retain original presentation DOM, CSS, responsive behavior, keyboard/pointer behavior and local UI state. Product data, policies, auth protocols, persistence, file access, network calls and operations are supplied through public inputs/callbacks. Independent components must not replace a mature view with a simpler design merely to remove its controller.

Agreed exclusions: browser extension features, confirmed unused leftovers, direct kernel-chat application and wallet/withdrawal. Direct kernel-chat-only workspace inspectors remain excluded; the reusable chat/process primitives used by room conversation are retained. Original OpenGrove app bootstrap, service controllers and product brand/kernel selection policy remain outside this package.

## Findings and resulting implementation

| Area | Previous gap or divergence | Result |
| --- | --- | --- |
| Run process | Original grouping, summaries, commentary, reasoning, tool detail and run controls absent; compact `AgentProcess` substituted | Original `process/activity-model`, `run-model`, `activity-presentation` and `room-run-presentation` extracted. Public `RunMessage` composes them. Compact export retained only for compatibility. |
| Mau conversation | Whole run inside `MessageView.content`; history withheld until all pages fetched | Uses `MessageView.body` and original separate process/answer presentation. RunReader publishes each event page and drains the final page when the run ends. |
| Host event mapping | Compact records could lose structured native detail | Public root adapter maps events to shared display parts, matching opaque call IDs; preserves command deltas, edits/search, public commentary, errors and full input/output. It does not call Host. |
| Approvals/questions | Generic Host cards instead of original room cards | Original cards use normalized display choices/questions; Mau delegates native interpretation/answers to Host. Opaque choice IDs, secrets, arrays, expired/completed states retained. Form/URL/unknown native requests use existing explicit fallback. |
| Resource/Markdown | Link/menu, skill cards and preview pieces missing | Original renderers and previews restored; URL/image/artifact resolution and actions are caller callbacks. No product API routes or credentials synthesized. |
| Employee views | Generic form/outer profile existed; editor fields, avatar and detailed subviews incomplete; wrong inline select | Original three-tab editor, model/provider/access descriptions and dangerous/disabled choices, avatar upload/generated/initials picker, activity and capabilities restored. |
| Contacts/groups | Missing group settings, remote connection/auth and contact subviews | Original group member management/rename/picker, avatar/name, contacts detail/delete and remote connection/auth views restored. Caller supplies membership and network lifecycle. |
| Files/editors | Native video and reduced preview replaced original preview; notices and flow missing | Original Vidstack player, standard preview/editor routing, Markdown metadata, flow rendering, selection attach and draft/conflict notices restored. Markdown defaults to original rich editor. Reads/saves/activity supplied externally. |
| App workbench | Styles existed without full dashboard/developer/chat/MCP views | Dashboard cards/metrics, developer split, workbench chrome/resizing, app chat/group selection, create/delete group, flow history and MCP frame restored. Transport and data remain external. |
| App creation/identity | Existing extraction | Existing wizard, form, icon/identity and creation states retained; independent package/browser regression verifies them including narrow dialog bounds. |
| App settings/versions | Existing generic page extraction | Existing settings/version panels retained; all original source files assigned in inventory; release-note Markdown restored. Product version operations are callbacks. |
| Catalog/publishing | Requirements and release/publish/recovery views absent/reduced | Original dependency/employee/doctor detail and publish release editor/checks/recovery/diagnostics restored. Catalog presentation explicitly chooses original or compatibility layout. No publish service embedded. |
| Extensions | Tab shell without full deployment/target dialogs | Original library/manager/identity rows, publish/redeploy/remove target dialogs restored, emitting explicit action records. |
| Settings | Storage, native desktop, provider picker and raw operations details missing | Original subviews restored. Existing appearance/kernel/mode/apps/network/voice/update presentation retained. Secrets and service actions remain owned by consumer. |
| Auth/startup/titlebar | Outer auth layout but missing email/code/invite/country/team/startup and controls | Full original subflows and startup/recovery views restored with caller labels/state/actions; chat/account/update/long-task titlebar controls restored. |
| Shared UI | Motion text, switch and slash menu missing | Original implementations restored. Existing root primitives reused through exports, with scoped portal/theme handling. |
| Mau stale tabs | No build check | Version file + noncached check/reload lifecycle; active runs, pending interactions, drafts and outgoing sends block automatic refresh. |

Additional callback fixes from interaction checks: pending employee/group submission cannot duplicate; dirty status alone creates the file toolbar; artifact URL resolver is passed through the run renderer; answered secret questions remain masked.

## Verification and limits

Evidence is intentionally separated:

- **Source audit:** 115 baseline component TSX files classified; original functions extracted where presentation and controller shared a file. This inventory is traceability, not an assertion that every possible state has a screenshot.
- **Original run comparison:** 64 equivalent fixtures across light/dark, English/Chinese, 1200/390 widths and collapsed/expanded process states; no pixel differences in those comparisons. Running/approval/question controls are also checked with their callback values.
- **Original additional view comparison:** 48 equivalent avatar/group/inline-select/release-note/flow/file fixtures; no pixel differences. Tests render original TSX with boundary shims and the retained packaged stylesheet on both sides, so they verify presentation under that stylesheet, not an independent proof of all CSS.
- **Restored view exercise:** 200 captures across 25 surfaces, four supplied states and two viewport/theme combinations. Some states are identical where not applicable. Separate behavior assertions cover employee tabs/drafts/busy submission, option descriptions/danger/disabled, avatar upload and error retention, group rename/member addition, contacts/provider selection, history expansion, keyboard resize, auth fields, pending forms, rich editing, file selection, original video, extension target intents and publish blockers/repair.
- **Independent packages:** root unit/browser/archive checks and frontend types/build/unit/browser/archive checks. A clean consumer installs packed packages, typechecks/builds, exercises controls and checks for service requests without repository aliases or a backend adapter.
- **Mau integration:** actual Mau/Router service with fixture Host/Matrix verifies stream text/tool details before refresh, open state through updates, approval restoration, exact native allow/deny/question answers, stop and historical state. RunReader tests cover cursor/page/end handling; build watcher tests cover blocked reload and cleanup. Fixture success is not claimed as live-model acceptance.

## Mau product availability

Mau now consumes the original run presentation and Host's public native interaction APIs. Already-working login, contacts, agent/environment/channel management remain product compositions. Mau's Files, Store, Extensions and related absent services remain explicitly unavailable; restoring their reusable frontend views does not invent those product backends or silently enable destructive actions. These are product service integrations, not missing extracted UI. The reusable components can be used independently by Mau or another product.

Reproduction: root `npm test`, `npm run test:browser`, `npm run test:package`; frontend `npm run build`, `npm test`, `npm run test:browser`, `npm run test:package`, `npm run test:restored`; original comparisons via the two `compare-*-presentation.mjs` scripts with the read-only baseline path. Mau: `npm test` with built web assets and `MAU_WEB_E2E=1` for browser acceptance.
