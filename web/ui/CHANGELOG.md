# Changelog

Notable changes to `@olorinm/agent-ui`, newest first. `@olorinm/agent-frontend` has its own
[`frontend/CHANGELOG.md`](frontend/CHANGELOG.md). Each version has a GitHub Release (`v*` tags) with
the same notes and the package archive. When releasing, add the new section here in the version-bump
commit; the Release notes are copied from it.

## [0.1.0-alpha.13] - 2026-11-11

- `EmployeeAvatar` draws a pixel-art animal by default: the seed picks one of twenty animals and a
  colour, as an inline SVG. The eyes show the state (`idle`, `working`, `offline`); the figure moves
  only on hover and bounces once when its control is pressed. `PixelAvatar`, `PixelAvatarGroup`,
  `pixelAvatarFor` and `PIXEL_AVATAR_SPECIES` are exported.
- The illustrated face remains as `appearance="illustrated"`, or for a whole subtree through
  `EmployeeAvatarAppearanceProvider`.

PR: [#14](https://github.com/Olorinm/agent-ui/pull/14)

## [0.1.0-alpha.12] - 2026-11-11

- App background is grey again, so white panels float on it; settings dialogs and pages keep their
  near-white surface through `--c-page`.

PR: [#13](https://github.com/Olorinm/agent-ui/pull/13)

## [0.1.0-alpha.11] - 2026-11-09

- Design-system tokens (type scale, spacing, radii, page and panel surfaces, compact density) and
  settings components: settings modal, modal and consent dialog, section/panel/row, text button,
  select menu, segmented control, search field, featured card, app icon, detail header and circular
  buttons.
- Semantic icons `apps`, `data`, `expand`, `eye`, `help`, `identity`, `key`, `logout`, `previous`.

PR: [#12](https://github.com/Olorinm/agent-ui/pull/12)

## [0.1.0-alpha.10] - 2026-11-06

- Codex dynamic tool results are read from `contentItems`, with JSON text parsed, instead of
  showing the whole native item.

PR: [#11](https://github.com/Olorinm/agent-ui/pull/11)

## [0.1.0-alpha.9] - 2026-11-05

- Reasoning comes from completed Codex items. Finished runs keep their reasoning now that Agent Host
  makes streaming deltas live-only. During a live run, a completed item replaces its streamed
  fragments.

PR: [#6](https://github.com/Olorinm/agent-ui/pull/6)

## [0.1.0-alpha.8] - 2026-10-30

- Native run parts appear in event order: Codex commentary in the process, and one final answer.
- Codex subagent activity.
- Restored the create-group dialog and @all mentions.

PR: [#5](https://github.com/Olorinm/agent-ui/pull/5)

## [0.1.0-alpha.7] - 2026-10-21

- Releases the merged main branch, together with Agent Frontend 0.1.0-alpha.7, so that the two
  packages share a unified run presentation. The package content is the same as 0.1.0-alpha.6.

PR: [#4](https://github.com/Olorinm/agent-ui/pull/4)

## [0.1.0-alpha.6] - 2026-10-16

- Native Host message and interaction projections for the original frontend run renderer. They keep:
  - call identity;
  - streaming command output;
  - structured native tool data;
  - opaque approval choices;
  - question fields.

## [0.1.0-alpha.5] - 2026-10-16

- `AgentProcess` and `projectAgentProcess` on the optional `agent-host` entry point: a public Host
  process view built from the existing Disclosure and ActivityRow components. It keeps invocation
  IDs, original tool arguments and results, and public commentary. Callers own events, labels,
  lifecycle and transport.
- The event accumulator treats `model.response` as the authoritative text snapshot.

## [0.1.0-alpha.4] - 2026-10-15

- The shared scoped portal API used by Agent Frontend 0.1.0-alpha.4.
- Project code is licensed under MIT; attribution and third-party notices are in `NOTICE`.

## [0.1.0-alpha.3] - 2026-10-15

- Caller-owned portal containers for dialogs, tooltips and toasts. Without a portal provider,
  consumers keep document portals.
- Controlled dialogs return focus to the element that opened them when they close.

## [0.1.0-alpha.2] - 2026-10-14

- First release from this repository. It was previously `packages/react` in Olorinm/agent-host.
- `@olorinm/agent-ui`: chat messages, Markdown, composer, process details, approvals, questions and
  resource cards. An optional `@olorinm/agent-ui/agent-host` interaction adapter.
- `@olorinm/agent-ui/app`: buttons, dialogs, confirmation, toasts, empty states, avatars, settings
  rows, status pills, tooltips and state indicators. Design tokens for light and dark themes, and
  a base reset, are in `@olorinm/agent-ui/app.css`.
- React 19 is a peer dependency.
