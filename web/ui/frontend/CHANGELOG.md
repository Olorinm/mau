# Changelog

Notable changes to `@olorinm/agent-frontend`, newest first. Each version has a GitHub Release
(`frontend-v*` tags) with the same notes and the package archive. When releasing, add the new
section here in the version-bump commit; the Release notes are copied from it.

## [0.1.0-alpha.14] - 2026-11-12

- Bundle the Agent UI 0.1.0-alpha.15 styles instead of alpha.6: dialogs get the 20px radius and the
  page surface, and a dark scrim in dark themes. Tokens that sheet defines are no longer repeated
  here. The peer requirement is `@olorinm/agent-ui@^0.1.0-alpha.15`.
- Sign-in, team access and startup scenes follow the dark theme.
- Buttons, fields, search boxes and select triggers that were 34px tall are 36px
  (`--control-height`).
- Every label a component asks for has English and Chinese text, including release progress,
  startup recovery and downloads, which showed their keys. Label text no longer names a product;
  pass `presentationLabels` to use your own wording.
- Remove style variables that nothing references.

## [0.1.0-alpha.13] - 2026-11-12

- Remove duplicate and unreferenced styles from frontend bundles.
- Consolidate repeated light-theme tokens while preserving their resolved values and existing variable names.
- Use a dark page surface for resolved dark themes and remove unreachable system-theme fallback rules.

## [0.1.0-alpha.12] - 2026-11-11

- Shell columns are white panels floating on the grey app background again, instead of hairline
  columns on a near-white page.

PR: [#13](https://github.com/Olorinm/agent-ui/pull/13)

## [0.1.0-alpha.11] - 2026-11-09

- Shell and chat follow the shared design system: page surface with hairline columns, grey
  selection and bubbles, floating composer; no blank lines between markdown blocks in bubbles.

PR: [#12](https://github.com/Olorinm/agent-ui/pull/12)

## [0.1.0-alpha.10] - 2026-11-06

- Tool rows with full input and output in the expandable code block show their arguments on one
  line.
- A running reply has one working line, always below what it has shown so far; the process summary
  is static, and the stop control is only on the working line.

PR: [#11](https://github.com/Olorinm/agent-ui/pull/11)

## [0.1.0-alpha.9] - 2026-11-06

- Slash commands in the conversation composer (`ConversationComposer.commands`).
- While a reply runs, the composer's send button stops it when the draft is empty.
- Draft attachments are cards with the remove button on the corner.
- `MessageFileCard` for files in sent messages; the sender's attachments sit above their text.
- `MessageView.continued` hides the repeated avatar and author line.
- The run process summary has no underline and leaves space before the reply.

PR: [#9](https://github.com/Olorinm/agent-ui/pull/9)

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

- Restores the remaining original components with their full presentation: run process
  (`RunMessage`), approval and question cards, Markdown and resource previews, employee, contact and
  group views, files and editors, app workbench, settings and auth flows. The compact
  `AgentProcess` stays only for compatibility.
- A build version check that reloads stale tabs, unless a run, interaction, draft or send is in
  progress.
- Data, auth, persistence and network calls come only from caller inputs and callbacks.

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

- Presentation components and styles: navigation, auth layout, conversations, profiles, app forms
  and icons, extension workspace, settings and files.
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
