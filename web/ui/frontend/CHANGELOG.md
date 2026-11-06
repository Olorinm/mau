# Changelog

Notable changes to `@olorinm/agent-frontend`, newest first. Each version has a GitHub Release
(`frontend-v*` tags) with the same notes and the package archive. When releasing, add the new
section here in the version-bump commit; the Release notes are copied from it.

## [0.1.0-alpha.8] - 2026-10-30

- Subagent activity rows.
- Restored the create-group dialog.
- @all mentions.

PR: [#5](https://github.com/Olorinm/agent-ui/pull/5)

## [0.1.0-alpha.7] - 2026-10-21

- Releases the merged main branch, together with Agent UI 0.1.0-alpha.7. The package content is
  the same as 0.1.0-alpha.6.

PR: [#4](https://github.com/Olorinm/agent-ui/pull/4)

## [0.1.0-alpha.6] - 2026-10-16

- The message body is kept, not replaced, when streaming output gains its final reply actions. The
  context-menu boundary stays mounted, so nested tool disclosures stay expanded or collapsed.

## [0.1.0-alpha.5] - 2026-10-16

- Complete extraction of the OpenGrove frontend, after an audit of all 115 original component
  files (`docs/` holds the inventory). Restored, with the original presentation:
  - **Run process.** Grouping, summaries, commentary, reasoning, tool detail and run controls.
    The public `RunMessage` composes them, and the compact `AgentProcess` stays only for
    compatibility.
  - **Conversations.** The original room approval and question cards, Markdown and resource
    renderers, and previews.
  - **Employees, contacts and groups.** Employee editor, avatar picker, group settings, contact
    detail and remote connection views.
  - **Files.** The Vidstack player, preview and editor routing, flow rendering, and draft and
    conflict notices.
  - **App workbench.** Dashboard, developer, chat and MCP views; catalog and publishing; extension
    deployment dialogs.
  - **Settings and auth.** Settings subviews, the full auth and startup flows, and titlebar
    controls.
- A build version check, plus a lifecycle for reloading stale tabs. Active runs, pending
  interactions, drafts and outgoing sends block automatic refresh.
- Product data, auth, persistence, network calls and operations come only from caller inputs and
  callbacks.

## [0.1.0-alpha.4] - 2026-10-15

- Catalog details use the native dialog primitive. It contains focus, closes on Escape and restores
  focus, inside the caller's scoped portal.
- Create-app actions fit 390px and 320px screens.
- Importing only the catalog styles also brings in the original action styles.
- Project code is licensed under MIT. Requires Agent UI 0.1.0-alpha.3 or later.

## [0.1.0-alpha.3] - 2026-10-15

- The original presentation is kept, using styles, themes and portals scoped to a subtree.
- Imports and styles for each feature.
- The original create-app dialog, provider forms and operation summaries, with data owned by the
  caller.
- A screenshot and interaction comparison CLI, and component stories, in the source repository.

## [0.1.0-alpha.2] - 2026-10-15

- Extracted the original OpenGrove presentation components and styles: navigation, auth layout,
  conversations, profiles, app forms and icons, extension workspace, settings and files.
- The original interactions are kept, including IME-safe input, menus, resizing and compact
  navigation.
- Service calls, authentication, storage and business decisions stay in the product that embeds
  these components.

## [0.1.0-alpha.1] - 2026-10-14

- Product-neutral React layouts and interactions, distributed as an independent package archive.
- Data, navigation, forms and operation callbacks are all owned by the caller. There is no backend
  client, auth flow, service protocol, browser storage or app router.
- Optional attributed artwork. Code and Markdown editing, with conflict presentation.
- Agent UI 0.1.0-alpha.2 and React 19 are peer dependencies.
