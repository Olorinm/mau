# Agent UI

Reusable React chat and application components for any product. Rendering is independent of Agent Host: bring your own messages, event source, interaction callbacks, file operations and styling.

This is an alpha package, distributed as a build archive. It is not published to the npm registry yet.

For product-neutral page layouts, navigation, conversations, form surfaces and
file editing, see the separate [Agent Frontend package](frontend/README.md).
It takes caller-owned data and callbacks and has no backend or product protocol dependency.
The separate page package does not add application runtime dependencies to this
low-level component package.

```sh
# From this repository:
npm ci
npm pack

# From a separate React 19 product:
npm install /path/to/olorinm-agent-ui-0.1.0-alpha.2.tgz
```

```tsx
import { useState } from "react";
import { ChatComposer, ChatMarkdown, ChatMessage } from "@olorinm/agent-ui";
import "@olorinm/agent-ui/styles.css";

export function Chat({answer, send}: {
  answer: string;
  send(text: string): void;
}) {
  const [text, setText] = useState("");
  return <div className="agent-chat">
    <ChatMessage role="assistant">
      <div className="thread-text-block"><ChatMarkdown markdown={answer} /></div>
    </ChatMessage>
    <ChatComposer value={text} onChange={setText}
      onSend={() => {send(text); setText("");}} />
  </div>;
}
```

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

Application components use `@olorinm/agent-ui/app.css`: tokens on `:root`, `data-theme="dark"` on the root element for dark mode, a small base reset, and `.agent-app` for the container. Confirm and toast copy uses the same `ChatProvider` translation.

Use `data-theme="dark"` on `.agent-chat` for the dark theme. Override CSS variables for colors, typography and spacing, or import only `thread.css`, `disclosure.css` and `cards.css` and supply your own theme. These styles use compatibility class names; importing them is explicit and opt-in.

The composer accepts `attachments`, `before`, `inputPrefix`, `footerLeft` and `footerRight` slots. The caller supplies model/settings choices from the selected kernel; the package does not hardcode a lowest-common-denominator model menu. The caller also owns attachment upload, safe resource resolution, image download and persistence.

`QuestionForm` returns `Record<string, string | string[]>`. Give each request a stable React key. Successful action callbacks stay locked until the parent replaces/removes the request; rejected callbacks show an error and allow retry. `AgentInteraction` handles request identity with its required `requestId`.

The optional Host adapter shows native approvals without renaming IDs or adding choices. Questions preserve multiple values and secret fields. Forms and unknown native requests have an explicit JSON editor with a `renderNative` replacement slot; it is not a complete JSON Schema form generator. URL elicitation requires explicit user completion. Provide `labels` for adapter copy and `ChatProvider.translate` for common controls.

See the [guide](docs/guide.md) and Agent Host's [independent editor](https://github.com/Olorinm/agent-host/tree/main/examples/react-editor). Verify with `npm test`, `npm run test:browser` and `npm run test:package`.

The presentation implementation was extracted from OpenGrove under Apache-2.0. Source and third-party attribution are in `NOTICE`. OpenGrove is a consumer of this package; its business models and services are not dependencies.

`PortalProvider` from `@olorinm/agent-ui/app` optionally places dialogs, tooltips
and toasts inside a caller-owned DOM container. Without it, existing document
portal behavior is preserved. `@olorinm/agent-frontend` uses this provider to keep
portaled content inside each frontend instance's theme boundary. Controlled
dialogs also restore the opener's focus unless the caller overrides close autofocus.
