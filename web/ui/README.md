# Agent UI (`web/ui`)

The React components of the Mau console, built as one private package, `@olorinm/agent-ui`, inside
the `web` npm workspace. The console (`web/src`) is its only consumer and imports it through the
package entries below; it is not published and does not provide UI for other products.

The package contains what the console uses: a module stays only while something the console imports
reaches it. Rendering takes caller-owned data and callbacks: there are no network calls, product
stores, backend startup or credential discovery in this package.

## Entries

| Export | Contents |
| --- | --- |
| `.` | Chat components: `ChatProvider`, `ChatMarkdown`, `ChatMessage`, `ChatComposer`, `Disclosure`, `ImagePreview`, activity, question and resource components |
| `./agent-host` | Agent Host adapter: `AgentInteraction`, `projectHostMessage`, `projectHostInteraction`, run views |
| `./app` | Application primitives and design-system components: buttons, dialogs, confirm, toasts, avatars, settings pages and rows |
| `./app.css` | Design tokens, base and application component styles (plain CSS on `:root`) |
| `./pages` | Page components: `AppShell`, `Navigation`, `ListDetailLayout`, `Conversation`, `RunMessage`, `Catalog`, `AppCreateDialog`, `ProfileDialog`, `CreateGroupForm`, `FileEditor` |
| `./pages.css` | One complete stylesheet for the page components, scoped under `.af-scope` at build time |

The console imports `./pages.css` and then `./app.css`.

## Layout

- `src/` — chat components (`index.ts`), the Host adapter (`agent-host.tsx`) and the chat
  stylesheets (`styles.css`, `thread.css`, `disclosure.css`), which the page stylesheet includes.
- `src/app/` — application primitives, design tokens and their stylesheets.
- `src/pages/` — page layouts and the conversation, run, catalog, app-creation, group and editor
  components; `style.css` lists the shared page stylesheets, CSS modules sit next to their component,
  and `presentation/labels.ts` holds the display text in English and Chinese.
- `test/` — unit tests and browser fixtures; `scripts/` — build steps and the browser test runners.

## Develop

From `web/`: `npm ci` installs the console and this package together (after `node scripts/bootstrap.mjs`
at the repository root has downloaded the Agent Kit archives). `npm run build` builds this package
first, then the console.

```sh
npm --workspace ui run typecheck
npm --workspace ui run build          # dist/: vite library build, declarations, stylesheets
npm --workspace ui test               # unit tests (after build)
npm --workspace ui run test:browser   # component fixtures and page acceptance in Chromium
```

Mau's CI builds the package through `npm run build:web` and runs the two test commands after it, in
the pinned Playwright container (`test` job in `.github/workflows/ci.yml`).
See the [component guide](docs/guide.md) for the chat, Host adapter and design-system APIs.

## Chat components and the Host adapter

| Export | Responsibility |
| --- | --- |
| `ChatMessage`, `ChatTranscript` | Message layout and caller-supplied rendering with stable keys |
| `ChatMarkdown`, `ImagePreview` | GFM, code, links, image actions and keyboard-accessible preview |
| `ChatComposer` | Controlled text, IME-safe submission, explicit stop, attachment/control slots |
| `Disclosure`, `ActivityRow`, `EditDiff` | Process groups, tool detail and edit presentation |
| `InteractionActions`, `QuestionForm` | Exact choices, multi-question answers, arrays, secrets and retryable callbacks |
| `ResourceCard` | Resource presentation and caller-owned open/context-menu actions |
| `ChatProvider` | Translation and button replacement |

`./agent-host` exports the pure `projectHostMessage(events, options)` and
`projectHostInteraction(id, request, state)` adapters. They produce the `MessagePart` display records
that `RunMessage` (`./pages`) renders as a conversation message's `body`. Call IDs preserve
simultaneous tools, commentary remains separate from final text, and native command/file/search data
stays available. The package never imports Host protocols: the console owns polling, run status,
cancellation and `describeInteraction`/`answerInteraction` from Agent Host. `AgentInteraction` shows
native approvals, questions, forms and URL requests without renaming IDs or adding choices.

## Page components

- `AppShell`, `Navigation`: titlebar, brand slot and caller-defined navigation entries and account menu.
- `ListDetailLayout`, `ItemList`, `PageHeader`, `SearchField`, `CollectionEmptyState`, `LoadingSurface`,
  `InlineNotice`: list/detail layout with compact back navigation, an inspector slot and empty states.
- `Conversation`, `RoomHeaderActions`, `MessageFileCard`: room stream, message bubbles, attachments
  and the IME-aware composer. `RunMessage` renders a run's process, approvals, questions and answer.
- `Catalog`, `AppCreateDialog`: cards for caller-supplied items and the app-creation dialog; creating
  or installing anything is a callback.
- `ProfileDialog`, `CreateGroupForm`: tabbed dialog and group-creation form with caller-owned data.
- `FileEditor`: the Markdown editor (Milkdown), falling back to the source editor (CodeMirror) when the
  rich editor cannot start. `value` and changes are caller-owned; reading and saving stay outside.
- `FrontendProvider`: theme (`light`, `dark`, `system`), language (`en`, `zh-CN`) and label overrides
  for one subtree and its portal host. It never changes `body`, `html` or browser storage.

The product supplies message state and performs delivery: `onSend` does not clear the draft, invent a
reply or select a backend.

## Styles

CSS Modules cover component internals; the shared page selectors and variables are scoped under
`.af-scope` at build time, so the page stylesheet does not restyle anything outside a
`FrontendProvider`. The page entry loads the shared stylesheet after the components' CSS modules.
`./app.css` is plain CSS: tokens on `:root`, `data-theme="dark"` on the root element or
`data-resolved-theme="dark"` on a theme boundary for dark mode, and `.agent-app` for the container.
`PortalProvider` (`./app`) places dialogs, tooltips and toasts inside a caller-owned DOM container.

CSS names inherited from the source are retained where renaming would break selectors; they are not
product branding or service dependencies.

## Source and license

`source-manifest.json` identifies, for each adapted file under `src/pages`, the original file with its
revision and hash, plus the boundary changes made during extraction. The hashes are provenance, not a
runtime compatibility mechanism.

This package's own code, including its extracted OpenGrove implementation, is licensed under the
[MIT License](LICENSE). The chat presentation components came from OpenGrove revision `d8c7a7c`; the
application primitives, design tokens and page components came from revision `8b365ed`. Those
revisions were distributed under Apache-2.0 at extraction. Source attribution and third-party terms
are retained in [NOTICE](NOTICE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), `licenses/` and
`source-manifest.json`; third-party components and dependencies keep their own licenses.
