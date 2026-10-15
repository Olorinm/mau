# Agent Frontend

`@olorinm/agent-frontend` provides product-neutral React layouts and interaction
components extracted from OpenGrove's existing presentation source. The original
markup, styles and UI interactions are retained; product controllers are replaced
with display values, slots and callbacks. It does not require OpenGrove services.

## Ownership

| Package | Owns |
| --- | --- |
| Agent Frontend | Layout, visual rendering, navigation presentation, editing interactions |
| Embedding product | Routes, navigation entries, authentication, data fetching, persistence, authorization and business workflows |
| Backend components | Their own public APIs and service behavior |

The frontend does not import or call Mau, Agent Router, Agent Host, Agent
Environment, Matrix, or OpenGrove services. It has no HTTP client, API base,
authentication callback, protocol schemas, event polling, browser storage, global
router, or application bootstrap. No service adapter is required to render it.

## Compose a product

```tsx
import { AppShell, Navigation, Conversation } from '@olorinm/agent-frontend';
import '@olorinm/agent-frontend/style.css';

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

Install React 19, React DOM 19 and the Agent UI alpha.2 archive in the consumer.
Agent UI is a peer dependency so shared providers have a single context instance. Components require no mounting
singleton and may be composed into an existing React tree or rendered separately.
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
  panels take values and callbacks. They do not probe devices, install kernels,
  update an application or save preferences themselves.
- `ProfileSurface`, `ProfileDialog`: original employee profile and tabbed dialog
  markup, with caller-supplied summaries, actions and detail content.
- `ExtensionsPage`: original workspace navigation, filters and extension rows;
  the caller chooses tabs and provides records and deployment controls.
- `AppCreateWizard`, `AppIconPicker`, `AppIdentityForm`: original forms and local
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

Low-level messages, tools, approval/question controls and UI primitives remain in
`@olorinm/agent-ui`. Its optional Host adapter is not imported by this package.

## Product boundary

There is no `mountFrontend`, `apiBase`, Fetch adapter, `passwordLogin`, service
capability registry or copied Bridge client. Navigation is ordinary caller data.

OpenGrove's email-code authentication, direct kernel chat page, wallet/withdrawal,
PM/delegation, historical message normalization, cloud account, desktop and store
workflows are not included. A product can build its own workflows using the same
visual components without implementing OpenGrove compatibility endpoints.

This package does not alter the upstream OpenGrove checkout. Adoption there is a
separate consumer migration, not a requirement for another product to use it.

## Verify and preview

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm run test:package
npm run dev
```

The demo uses explicitly local example data and callbacks, with no backend.
Tests enforce the dependency boundary, server-render two independent brands,
exercise callbacks/error states and file editing, inspect compact/dark layouts,
and reject service requests. The archive test installs the real tarball in an
independent temporary consumer with no source aliases or repository dependencies.
These are component tests, not acceptance of live cloud/model services.

See `source-manifest.json`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` for attribution.
The manifest records adapted presentation sources; it is not a promise to mirror
OpenGrove's application or synchronize product features.

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
