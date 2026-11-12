# Agent UI guide

`@olorinm/agent-ui` supplies message, Markdown, composer, process, approval, question and resource components, plus the application primitives in `@olorinm/agent-ui/app`. [Agent Host](https://github.com/Olorinm/agent-host) can be used without React or this package.

This package is built inside the Mau `web` workspace and consumed from there (see the [README](../README.md)).

React and React DOM 19 are peer dependencies. The package root only renders caller-owned data. It makes no HTTP calls and has no product-specific stores, authentication, room membership, filesystem access or knowledge of business objects.

## Connect Agent Host

The optional `/agent-host` entry accepts Agent Host's existing interaction callback:

```tsx
import { AgentInteraction, useAgentInteractions } from "@olorinm/agent-ui/agent-host";

function Interactions() {
  const {pending, onInteraction} = useAgentInteractions();
  // Pass onInteraction to task.wait({onInteraction}) or your embedded integration.
  // The product still decides when to start/observe/cancel the task.
  return pending.map(item => <AgentInteraction
    key={item.id} requestId={item.id}
    request={item.request} onReply={item.reply}
  />);
}
```

The hook handles concurrent requests and removes/rejects them when their abort signal fires or the UI unmounts. Native replies are translated by Agent Host, not by the presentation package. Errors from remote submission remain part of the caller's observer/error handling.

`createRunView(runId)` and `appendRunEvent(view, {sequence, event})` project text and reasoning from ordered HTTP service events. They ignore replayed sequences, reject events for another run and retain original events for custom renderers. They are an in-memory view, not a durable conversation store. Use the final run result as the authoritative answer and handle `onHistoryGap` explicitly.

## Native capability boundaries

- Approval choices retain exact IDs and native persistence scopes. An empty choice list never gains an invented “allow” button.
- Questions return strings/arrays by their original IDs. The Host adapter disables skipping required IDs and uses password inputs for secret questions.
- Native forms use a JSON response editor with the original schema available. Complex schema-driven widgets can replace it through `renderNative`; the kernel/service remains responsible for native validation.
- URL requests open only HTTP(S) links and require explicit completion. Unknown native requests remain explicit JSON replies.
- Model, effort, mode, permission and budget menus belong in composer slots. Populate them using the selected runtime's capabilities and allowed settings.
- Attachment upload, resource identity, authorization, downloads, persistence, accounts, Rooms and Apps remain product responsibilities.

## Styling and localization

Import `@olorinm/agent-ui/styles.css` and wrap your UI in `.agent-chat` for a default theme; set `data-theme="dark"` for dark mode. All colors/spacing/typography use CSS variables. Existing products can import the three component stylesheets and keep their tokens. CSS imports are optional and do not reset the document root.

`@olorinm/agent-ui/app` adds product-neutral application primitives: buttons, dialogs, confirmation, toasts, empty states, avatars, settings rows, status pills, tooltips and state indicators. Import `@olorinm/agent-ui/app.css` once. Unlike the chat stylesheet, it defines tokens on `:root` (so portaled dialogs and toasts share them), switches to dark with `data-theme="dark"` on the root element, and applies a small base (`box-sizing`, heading/paragraph margins, focus ring, reduced motion). Use `.agent-app` on the application container for its background and typography.

### Design system

`@olorinm/agent-ui/app.css` also defines the shared design tokens: a near-white page (`--c-page`) with solid grey,
borderless panels (`--c-panel`, `--r-panel: 16px`), the type scale (`--fs-body: 14px`, `--fs-note: 13px`,
`--fs-emphasis: 15px`, `--fs-dialog-title: 18px`, `--fs-page-title: 21px`, `--lh-body: 1.6`), control and row heights
(`--h-control: 36px`, `--h-row: 48px`), icon tiles (`--size-tile-sm: 32px`, `--size-tile: 40px`), the settings
navigation (`--w-settings-nav: 225px`) and modals (`--w-modal: 512px`, `--r-modal: 20px`). Brand colors stay the
accent, success and error tokens. `data-density="compact"` (or `DensityScope`) switches a subtree to the compact sizes
used for run details, events, approvals and logs.

The components built on them render caller-owned data only:

- `SettingsDialog` + `SettingsPage`: the settings modal with an icon navigation; below 640 px it fills the screen, the
  navigation becomes the first page and pages get a back button. `Modal`/`ModalActions` (full-width pill primary
  button and a plain-text cancel) and `ConsentDialog` (icon, title, three explanatory items, footnote) share its shell.
- `SettingsSection` (grey label, panel, optional note), `GroupPanel`, `ListRow` (icon, title, optional second line,
  separate trailing control), `TextButton`, `SelectMenu` (text and chevron, e.g. Allow / Ask / Don't allow),
  `SegmentedControl`, `SearchField`, `FeaturedCard`/`FeaturedGrid`, `AppIcon`, `DetailHero`, `CircleBackButton`,
  `CircleButton` and `InitialAvatar`.

Menus opened inside these modals render inside them; Escape closes an open menu before the modal.

`EmployeeAvatar` draws an agent from a seed (usually its id). Its default appearance is a pixel-art animal
(`PixelAvatar`): the seed picks one of twenty animals and a colour, the same every time, and the figure is an inline
SVG with no network request. `state` is shown by the eyes (`idle`, `working` looks aside, `offline` closes them and
greys the figure). The figure is still until it, or the button, link or `[data-avatar-hover]` element around it, is
hovered, and bounces once when that control is pressed; `animated={false}` turns the motion off where many avatars
repeat. `PixelAvatarGroup` stacks up to three members' figures for a group. The earlier illustrated face remains:
pass `appearance="illustrated"`, or wrap a subtree in `EmployeeAvatarAppearanceProvider` to choose it for every avatar
below. `pixelAvatarFor(seed)` returns the animal and colour a seed resolves to, and `species` pins a chosen animal.

`ChatProvider` accepts a `translate` function and a `Button` replacement. `AgentInteraction.labels` replaces adapter copy. Message render callbacks, composer slots, resource actions and native interaction renderers let the product retain its own UI conventions.

## Working example and verification

Agent Host's [React document editor](https://github.com/Olorinm/agent-host/tree/main/examples/react-editor) uses the HTTP client and an authenticated local companion. The Host owner token stays in that companion. Product document writes still require an explicit UI decision.

```sh
npm test
npm run test:browser
```

`test:browser` drives the chat and application fixtures and the page acceptance checks in Chromium.

Source attribution is preserved in [NOTICE](../NOTICE).
