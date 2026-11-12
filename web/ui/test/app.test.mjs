import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatProvider } from "../dist/index.js";
import {
  Button,
  ConfirmProvider,
  EmployeeAvatar,
  EmployeeAvatarAppearanceProvider,
  EmptyState,
  ListRow,
  ObjectSettingsRow,
  SettingsSection,
  TextButton,
  ObjectSettingsSection,
  PIXEL_AVATAR_SPECIES,
  PixelAvatar,
  PixelAvatarGroup,
  pixelAvatarFor,
  ProductStatus,
  ToastProvider,
} from "../dist/app/index.js";

test("application primitives render without product stores or network access", () => {
  const html = renderToStaticMarkup(
    h(ObjectSettingsSection, { title: "Environment" },
      h(ObjectSettingsRow, { title: "State", value: h(ProductStatus, { tone: "warning", label: "Needs action" }) }),
      h(ObjectSettingsRow, { title: "Open", onClick() {} }),
    ),
  );
  assert.match(html, /agent-ui-settings-section/);
  assert.match(html, /data-tone="warning"[^>]*>.*Needs action/);
  assert.match(html, /<button class="agent-ui-settings-row agent-ui-settings-row-plain agent-ui-settings-button" type="button">/);
  const leading = renderToStaticMarkup(h(ObjectSettingsRow, { title: "Helper", leading: h("span", null, "A") }));
  assert.match(leading, /class="agent-ui-settings-row">/);
  assert.match(renderToStaticMarkup(h(Button, { variant: "primary" }, "Create")), /class="primary-button" type="button"/);
});

test("empty states and employee avatars keep caller-owned labels and deterministic fallbacks", () => {
  const empty = renderToStaticMarkup(
    h(EmptyState, { illustration: "sprout", title: "No agents", actions: [{ label: "Create", onClick() {}, variant: "primary" }] }),
  );
  assert.match(empty, /og-empty-state/);
  assert.match(empty, /<svg[^>]*aria-hidden="true"/);
  assert.match(empty, /class="primary-button"[^>]*>Create</);
  const avatar = renderToStaticMarkup(h(EmployeeAvatar, { seed: "agent-1", fallbackName: "Helper", size: 40 }));
  assert.match(avatar, /width:40px/);
  assert.doesNotMatch(avatar, /<img/);
});

test("employee avatars are pixel animals by default and keep the illustrated face as a choice", () => {
  const pixel = renderToStaticMarkup(h(EmployeeAvatar, { seed: "agent-1", size: 40, state: "working" }));
  assert.match(pixel, /class="agent-pixel-avatar"[^>]*data-state="working"/);
  assert.match(pixel, /width:40px;height:40px/);
  assert.match(pixel, /<svg viewBox="0 0 10 10"/);
  // The same seed always gives the same animal and colour; a chosen animal keeps its own palette.
  assert.deepEqual(pixelAvatarFor("agent-1"), pixelAvatarFor("agent-1"));
  assert.ok(PIXEL_AVATAR_SPECIES.includes(pixelAvatarFor("agent-1").species));
  assert.equal(pixelAvatarFor("agent-1", "panda").species, "panda");
  assert.equal(PIXEL_AVATAR_SPECIES.length, 20);
  assert.ok(new Set(Array.from({ length: 200 }, (_, index) => pixelAvatarFor("agent-" + index).species)).size >= 18);
  for (const species of PIXEL_AVATAR_SPECIES)
    assert.match(renderToStaticMarkup(h(PixelAvatar, { seed: "x", species })), new RegExp(`data-species="${species}"`));
  // Offline closes the eyes; a title makes the figure a labelled image, otherwise it is decorative.
  assert.match(renderToStaticMarkup(h(PixelAvatar, { seed: "x", species: "cat", state: "offline" })), /height="0\.8"/);
  assert.match(renderToStaticMarkup(h(PixelAvatar, { seed: "x", title: "Helper" })), /role="img" aria-label="Helper"/);
  assert.match(renderToStaticMarkup(h(PixelAvatar, { seed: "x" })), /aria-hidden="true"/);
  assert.doesNotMatch(renderToStaticMarkup(h(PixelAvatar, { seed: "x", animated: false })), /data-animated/);
  const group = renderToStaticMarkup(h(PixelAvatarGroup, { seeds: ["a", "b", "c", "d"], size: 40 }));
  assert.equal(group.match(/class="agent-pixel-avatar"/g).length, 3);
  const illustrated = renderToStaticMarkup(
    h(EmployeeAvatarAppearanceProvider, { appearance: "illustrated" }, h(EmployeeAvatar, { seed: "agent-1", fallbackName: "Helper", size: 40 })),
  );
  assert.doesNotMatch(illustrated, /agent-pixel-avatar/);
  assert.match(illustrated, /agent-ui-avatar-root/);
  assert.match(renderToStaticMarkup(h(EmployeeAvatar, { seed: "agent-1", appearance: "illustrated" })), /agent-ui-avatar-root/);
});

test("confirm and toast providers render on the server without a document", () => {
  const html = renderToStaticMarkup(
    h(ChatProvider, { translate: (key) => `[${key}]` },
      h(ConfirmProvider, null, h(ToastProvider, null, h("main", null, "content")))),
  );
  assert.match(html, /<main>content<\/main>/);
});

test("the application stylesheet defines light and dark tokens used by portaled surfaces", async () => {
  const tokens = await readFile(new URL("../dist/app/tokens.css", import.meta.url), "utf8");
  assert.match(tokens, /^:root \{/m);
  assert.match(tokens, /^:root\[data-theme="dark"\] \{/m);
  for (const name of ["--c-surface", "--modal-overlay-bg", "--z-modal", "--shadow-lg"])
    assert.match(tokens, new RegExp(`\\n  ${name}:`));
  const app = await readFile(new URL("../dist/app/app.css", import.meta.url), "utf8");
  assert.match(app, /@import "\.\/tokens\.css";/);
  assert.match(app, /@import "\.\/components\.css";/);
});

test("design-system rows keep the trailing action separate and expose density and tokens", async () => {
  const html = renderToStaticMarkup(
    h(SettingsSection, { title: "Write access", note: "Ask is refused in scheduled work.", density: "compact" },
      h(ListRow, { title: "Send email", onClick() {}, ariaLabel: "Send email", trailing: h(TextButton, null, "Add") }),
      h(ListRow, { title: "Manage labels", muted: true, subtitle: "Needs more access" }),
    ),
  );
  assert.match(html, /data-density="compact"/);
  assert.match(html, /<button type="button" class="agent-list-row-main" aria-label="Send email">/);
  assert.match(html, /class="agent-list-row-trailing"><button type="button" class="agent-text-button" data-tone="primary">Add/);
  assert.match(html, /data-muted=""[^>]*data-two-line=""/);
  const tokens = await readFile(new URL("../dist/app/tokens.css", import.meta.url), "utf8");
  for (const name of ["--c-panel", "--fs-page-title", "--h-row", "--h-control", "--r-panel", "--r-modal", "--w-settings-nav", "--size-tile"])
    assert.match(tokens, new RegExp(`\\n  ${name}:`));
  assert.match(tokens, /\[data-density="compact"\] \{/);
  const app = await readFile(new URL("../dist/app/app.css", import.meta.url), "utf8");
  assert.match(app, /@import "\.\/surfaces\.css";/);
  assert.match(app, /@import "\.\/pixel-avatar\.css";/);
  assert.match(await readFile(new URL("../dist/app/pixel-avatar.css", import.meta.url), "utf8"), /\.agent-pixel-avatar\[data-state="offline"\]/);
});
