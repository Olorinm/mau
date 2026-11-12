# Agent UI (`web/ui`)

The React components of the Mau console, built as one private package, `@olorinm/agent-ui`, inside
the `web` npm workspace. The console consumes it directly from this directory; it is not published.

- **Components** (`src/`): chat messages, Markdown, composer, process, approval, question and
  resource components, the optional Agent Host adapter, and the application primitives and design
  tokens in `./app`.
- **Pages** (`src/pages/`): product-neutral page layouts, navigation, conversations, settings,
  catalog, extension and file-editing surfaces built on the components.

Rendering takes caller-owned data and callbacks: there are no network calls, product stores,
backend startup or credential discovery.

## Entries

| Export | Contents |
| --- | --- |
| `.` | Chat components (`ChatMessage`, `ChatMarkdown`, `ChatComposer`, `Disclosure`, …) |
| `./agent-host` | Agent Host interaction hook/components and event projection |
| `./app` | Application primitives and design-system components |
| `./styles.css`, `./thread.css`, `./disclosure.css`, `./cards.css` | Chat stylesheets |
| `./app.css` | Design tokens, base and application component styles |
| `./pages`, `./pages.css` | Every page component, and one stylesheet for all of them |
| `./shell`, `./conversation`, `./settings`, `./files`, `./catalog`, `./extensions`, `./auth`, `./profile` | Feature subsets of `./pages`, each with a matching `.css` |

Page stylesheets are complete and scoped under `.af-scope` at build time; the component
stylesheets are plain CSS copied as written.

## Develop

From `web/`: `npm ci` installs the console and this package together. `npm run build` builds this
package first, then the console.

```sh
npm --workspace ui run typecheck
npm --workspace ui run build          # dist/: vite library build, declarations, stylesheets
npm --workspace ui test               # unit tests (after build)
npm --workspace ui run test:browser   # component fixtures and page acceptance in Chromium
npm --workspace ui run test:restored  # restored page surfaces: renders and interactions
npm --workspace ui run dev            # demo and stories against the built package
```

Mau's CI runs these in the pinned Playwright container (`ui` job in `.github/workflows/ci.yml`).
See the [component guide](docs/guide.md) for the chat, Host adapter and design-system APIs.

## Chat components

| Export | Responsibility |
| --- | --- |
| `ChatMessage`, `ChatTranscript` | Message layout and caller-supplied rendering with stable keys |
| `ChatMarkdown`, `ImagePreview` | GFM, code, links, image actions and keyboard-accessible preview |
| `ChatComposer` | Controlled text, IME-safe submission, explicit stop, attachment/control slots |
| `Disclosure`, `ActivityRow`, `EditDiff` | Process groups, tool detail and edit presentation |
| `InteractionActions`, `QuestionForm` | Exact choices, multi-question answers, arrays, secrets and retryable callbacks |
| `ResourceCard` | Resource presentation and caller-owned open/context-menu actions |
| `ChatProvider` | Translation and button replacement |
| `@olorinm/agent-ui/agent-host` | Optional Agent Host interaction hook/components and ordered event projection |
| `@olorinm/agent-ui/app` | `Button`, `Dialog`, `ConfirmProvider`, `ToastProvider`, `EmptyState`, `NameAvatar`/`EmployeeAvatar`, `ObjectSettingsSection`/`Row`, `ProductStatus`, `Tooltip`, `AgentStateIndicator` |

There are no network calls, product stores, backend startup or credential discovery in this package. React is a peer dependency of this package only, not a dependency of Agent Host.

Application components use `@olorinm/agent-ui/app.css`: tokens on `:root`, `data-theme="dark"` on the root element or `data-resolved-theme="dark"` on a theme boundary for dark mode, a small base reset, and `.agent-app` for the container. Confirm and toast copy uses the same `ChatProvider` translation.

Use `data-theme="dark"` on `.agent-chat` for the dark theme. Override CSS variables for colors, typography and spacing, or import only `thread.css`, `disclosure.css` and `cards.css` and supply your own theme. These styles use compatibility class names; importing them is explicit and opt-in.

The composer accepts `attachments`, `before`, `inputPrefix`, `footerLeft` and `footerRight` slots. The caller supplies model/settings choices from the selected kernel; the package does not hardcode a lowest-common-denominator model menu. The caller also owns attachment upload, safe resource resolution, image download and persistence.

`QuestionForm` returns `Record<string, string | string[]>`. Give each request a stable React key. Successful action callbacks stay locked until the parent replaces/removes the request; rejected callbacks show an error and allow retry. `AgentInteraction` handles request identity with its required `requestId`.

The optional Host adapter shows native approvals without renaming IDs or adding choices. Questions preserve multiple values and secret fields. Forms and unknown native requests have an explicit JSON editor with a `renderNative` replacement slot; it is not a complete JSON Schema form generator. URL elicitation requires explicit user completion. Provide `labels` for adapter copy and `ChatProvider.translate` for common controls.

`PortalProvider` from `@olorinm/agent-ui/app` optionally places dialogs, tooltips
and toasts inside a caller-owned DOM container. Without it, existing document
portal behavior is preserved. The page components use this provider to keep
portaled content inside each frontend instance's theme boundary. Controlled
dialogs also restore the opener's focus unless the caller overrides close autofocus.

### Host execution process

`@olorinm/agent-ui/agent-host` exports the pure `projectHostMessage(events, options)`
and `projectHostInteraction(id, request, state)` adapters. They produce the shared
`MessagePart` display records consumed by the original `RunMessage` (`@olorinm/agent-ui/conversation`).
Call IDs preserve simultaneous tools, commentary remains separate from final text,
and native command/file/search data and complete input/output remain available.
The frontend never imports Host protocols. The embedding product owns polling,
run status, cancellation and `describeInteraction`/`answerInteraction` from Host.
Choice IDs and reply formats remain native; secret and multiple-value fields are
preserved. Use `AgentInteraction` for Host's form, URL and unknown-native requests.

Use `RunMessage` from `@olorinm/agent-ui/conversation` as a
conversation message's `body`, which preserves its own process area and bubbles.

## Ownership

| Package | Owns |
| --- | --- |
| Page components | Layout, visual rendering, navigation presentation, editing interactions |
| Embedding product | Routes, navigation entries, authentication, data fetching, persistence, authorization and business workflows |
| Backend components | Their own public APIs and service behavior |

The page components do not import or call Mau, Agent Router, Agent Host, Agent
Environment, Matrix, or OpenGrove services. It has no HTTP client, API base,
authentication protocol, protocol schemas, event polling, browser storage, global
router, or application bootstrap. No service adapter is required to render it.

## Compose a product

```tsx
import { AppShell, Navigation, Conversation } from '@olorinm/agent-ui/pages';
import '@olorinm/agent-ui/pages.css';

<AppShell brand="My product" navigation={
  <Navigation items={navigationItems} selectedId={page} onSelect={setPage} />
}>
  <Conversation
    messages={messages.map(message => ({
      id: message.id,
      role: message.fromMe ? 'user' : 'assistant',
      content: <p>{message.text}</p>,
    }))}
    composer={{ value: draft, onChange: setDraft, onSend: sendFromMyProduct }}
    notice={error && <p role="alert">{error}</p>}
  />
</AppShell>
```

The product supplies message state and performs delivery. `onSend` does not clear
the draft, invent an assistant reply, or select a backend. Supply pending/error
state and update the input after the product confirms its operation. A callback
may use any service or local state; the component does not know which.

React 19 and React DOM 19 are peer dependencies. The page and component entries share one build, so shared
providers have a single context instance. Components require no mounting singleton and may be composed into an existing React tree or rendered separately.
Use a viewport meta tag for compact layouts. `AppShell` fills its parent's height;
the product owns the document, routing, theme selection and deployment policy.
`FrontendProvider` accepts `language="en" | "zh-CN"`, optional presentation label
overrides, and instance-local text for the assembly components; it never mutates
the document language. Importing CSS is an explicit opt-in to the shared design
tokens and component styling. Editor JavaScript loads lazily when used.

## Components

- `AppShell`, `Navigation`: titlebar, brand/toolbar slots and caller-defined entries.
- `ListDetailLayout`, `ItemList`, `PageHeader`, `DetailPanel`: contacts, conversations,
  resource lists or other caller-defined entities; compact back navigation.
- `Conversation`: original room stream, message bubbles, hover actions, reply and
  mention UI, attachments and IME-aware composer. `RoomHeaderActions` retains the
  original search/rename menus. `RoomComposer`, `RoomChatSurface` and
  `RoomMessageStream` are also available separately. Tool
  activity, approval choices and other message content can be supplied as React
  nodes without coupling to a kernel protocol.
- `AuthLayout`, `AuthField`, `AuthSubmit`: original form layout and styling. All fields,
  validation, submission and authentication are supplied by the product.
- `Catalog`: cards for caller-supplied apps, extensions or other items; no store,
  purchase, installation or extension-management implementation.
- `SettingsLayout`: original settings navigation and page chrome. Original
  appearance, mode, kernel, apps, network, voice, desktop overview and updater
  panels, provider forms and operations summaries take values and callbacks. They do not probe devices, install kernels,
  update an application or save preferences themselves.
- `ProfileSurface`, `ProfileDialog`: original employee profile and tabbed dialog
  markup, with caller-supplied summaries, actions and detail content.
- `ExtensionsPage`: original workspace navigation, filters and extension rows;
  the caller chooses tabs and provides records and deployment controls.
- `AppCreateDialog`, `AppCreateWizard`, `AppIconPicker`, `AppIdentityForm`: original forms and local
  icon selection/upload interaction. Creating or importing an app is a callback.
- `VersionHistory`, `VersionSwitchBlocker`: original version presentation and
  confirmation dialog, with no version-selection or publishing service.
- `FileEditor`: code/Markdown editor adapted from the original CodeMirror/Milkdown
  implementation. `value`, changes and selection are caller-owned. Reading,
  saving and conflict policy stay outside the component.
- `FilePreview`, `FileConflictEditor`: content/media preview and conflict editing.
  Resource URLs are supplied by the product, never synthesized as vault or API
  paths. Media elements may load supplied URLs; downloads and authenticated
  resources remain the caller's responsibility.
- `SaplingPlaceholder`, `ConstellationPlaceholder`: optional attributed artwork.
  No product name or artwork is selected automatically.

Low-level messages, tools, approval/question controls and UI primitives are the component entries
(`.`, `./app`). The optional Host adapter (`./agent-host`) is not imported by the page components.

## Product boundary

There is no `mountFrontend`, `apiBase`, Fetch adapter, `passwordLogin`, service
capability registry or copied Bridge client. Navigation is ordinary caller data.

OpenGrove's email-code authentication, direct kernel chat page, wallet/withdrawal,
PM/delegation, historical message normalization, cloud account, desktop and store
workflows are not included. A product can build its own workflows using the same
visual components without implementing OpenGrove compatibility endpoints.

## Source changes

`source-manifest.json` identifies the original file and its revision/hash, plus
the boundary changes made during extraction. These hashes are provenance, not
a runtime compatibility mechanism. The main changes are:

- Keep UI state such as menu visibility, drag widths, IME guards and focus handling.
- Replace service records with the fields needed to display a row or card.
- Move authentication, requests, subscriptions, storage, protocol normalization
  and business decisions to the embedding application.
- Supply brand, artwork, navigation, unavailable states and actions explicitly.

`AppShell`, `Conversation` and the list/detail wrappers assemble those original
renderers. They are integration glue, not a second implementation of the pages.
CSS names inherited from the source are retained where renaming would break
selectors; they are not product branding or service dependencies.

Mau currently connects authentication, Agent/environment controls, channels,
account messages and files. The additional settings/store/extension entries
remain visible with an explicit unavailable notice; this package does not make
those product services exist. Operations/provider-specific content is supplied
through settings slots rather than shipping their original service controllers.

## Style and component boundaries

Keep the source-derived markup and CSS. CSS Modules cover component internals;
original shared selectors and variables are scoped at build time under
`.af-scope`. Do not replace the design system with Tailwind as part of extraction.
`FrontendProvider theme="light" | "dark" | "system"` owns that subtree and its
portal host. Two instances can use different themes; the library does not change
`body`, `html`, global theme tokens, localStorage or unrelated controls.
`AppShell` and `AuthLayout` provide a default scope when used alone. Wrap smaller
components in `FrontendProvider` (or `FrontendScope`) when using them independently.

Whole layouts provide original defaults, with slots for product content. Local
interaction state (an open menu, icon search, editor selection) stays in the UI.
Data state and effects (saving, fetching, permissions, login, installing an app)
stay in the product. Do not create a component merely to shorten a file; extract
it when it has a clear interaction or repeated presentation responsibility.

Feature imports avoid unrelated editor JavaScript and editor theme CSS:

```tsx
import { FrontendProvider, AppShell } from '@olorinm/agent-ui/shell';
import '@olorinm/agent-ui/shell.css';
import { Conversation } from '@olorinm/agent-ui/conversation';
import '@olorinm/agent-ui/conversation.css';
```

Available entries: `shell`, `conversation`, `settings`, `files`, `catalog`,
`extensions`, `auth`, `profile`. Each has a corresponding `.css` export. `./pages`
and `pages.css` retain the complete API for consumers that use all views.
Shared base styles can repeat when several feature stylesheets are imported;
this favors ordinary CSS imports and predictable standalone usage.

Use `AppCreateDialog` for the original desktop overlay/mobile page behavior.
`AppCreateWizard` is the inner form for callers that intentionally need it alone.
Opening a dialog should preserve the background page and restore focus on close.

`npm run dev` serves the demo (`demo/`) against the built package; `/stories.html` contains
stateful presentation stories. Its records/actions are examples, not services.

## Restored presentation surfaces

- `RunMessage`: original process grouping, tool summaries/details, edits, commentary,
  reasoning, resources, approvals/questions and separate answer bubbles. Give it
  stable IDs, display `MessagePart[]`, status and intent callbacks. Place it in
  `MessageView.body`; `content` is for a single message bubble. `resourceOperations`
  supplies artifact/image URLs and image save/download/preview operations.
- `EmployeeEditor`, `EmployeeAvatarPicker`, `EmployeeActivity`,
  `EmployeeCapabilities`, `Contacts`, `RoomSettingsPanel`, `RemoteAgentDialog`,
  `NetworkAuthorizationDialog`: original employee/group/contact subviews with
  caller-owned catalogs, permissions, requests and results. `RoomInlineSelect`
  retains option descriptions, danger styling and disabled choices.
- `FilePreview`, `StandardFilePreview`, `FlowPreview`, `MarkdownPreview`,
  `FilePanel`, `FileDraftNotices`: original metadata, media player, flow activity,
  selection attachment and conflict/save notices. `FileEditor` uses the original
  rich Markdown editor by default; set `richText={false}` for source editing.
- `DashboardPreview`, `AppWorkbench`, `MountedAppDeveloperLayout`, `AppChatPanel`,
  `AppFlowList`, `AppCreateGroupDialog`, `AppDeleteGroupDialog`, `McpAppFrame`:
  mounted-app presentation, history, resizing, group selection and app framing.
  The caller supplies app/flow data, file views and MCP transport.
- `AppStorePublishReleaseEditor`, catalog detail and extension workspace exports:
  requirement details, draft/check/recovery state, deployment targets and explicit
  publish/remove intents. These components do not publish, deploy or fetch.
- Storage/native desktop/provider picker/operations settings, release-note Markdown,
  auth email/code/invite/country/team forms, startup/recovery views and titlebar
  controls are separately exported. Credentials, auth flows, update policy,
  persistence and native operations stay with the embedding product.

## License

This package's own code, including its extracted OpenGrove implementation, is licensed under the
[MIT License](LICENSE). The chat presentation components came from OpenGrove revision `d8c7a7c`; the
application primitives, design tokens and page components came from revision `8b365ed`. Those
revisions were distributed under Apache-2.0 at extraction. Source attribution and third-party terms
are retained in [NOTICE](NOTICE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), `licenses/` and
`source-manifest.json`; third-party components and dependencies keep their own licenses.
