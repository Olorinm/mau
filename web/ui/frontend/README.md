# Agent Frontend

`@olorinm/agent-frontend` provides product-neutral React layouts and interaction
components adapted from OpenGrove's presentation code. It is not a copy of the
OpenGrove application and does not require its backend.

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
`FrontendProvider` supplies instance-local presentation labels; it never mutates
the document language. Importing CSS is an explicit opt-in to the shared design
tokens and component styling. Editor JavaScript loads lazily when used.

## Components

- `AppShell`, `Navigation`: titlebar, brand/toolbar slots and caller-defined entries.
- `ListDetailLayout`, `ItemList`, `PageHeader`, `DetailPanel`: contacts, conversations,
  resource lists or other caller-defined entities; compact back navigation.
- `Conversation`: message presentation and composer, composed from Agent UI. Tool
  activity, approval choices and other message content can be supplied as React
  nodes without coupling to a kernel protocol.
- `AuthLayout`, `AuthField`, `AuthSubmit`: original form layout and styling. All fields,
  validation, submission and authentication are supplied by the product.
- `Catalog`: cards for caller-supplied apps, extensions or other items; no store,
  purchase, installation or extension-management implementation.
- `SettingsLayout`: caller-defined sections and controls; no built-in billing,
  desktop updater, account, provider or kernel settings.
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

## Removed from the earlier draft

The previous unreleased draft's `mountFrontend`, `apiBase`, Fetch adapter,
`passwordLogin`, `unavailableFeatures`, copied Bridge/protocol clients and source
application are removed. Product navigation is now ordinary caller data.

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
