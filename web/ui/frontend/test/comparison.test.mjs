import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { comparePixels } from "../tools/ui-compare.mjs";
import { scopeStyles } from "../scripts/scoped-styles.mjs";

test("comparison fails on visual changes and size changes, with a diff artifact", () => {
  const a = new PNG({ width: 20, height: 20 });
  a.data.fill(255);
  const same = PNG.sync.write(a);
  assert.equal(comparePixels(same, same).passed, true);
  for (let i = 0; i < a.data.length; i += 4) a.data[i] = 0;
  const changed = comparePixels(same, PNG.sync.write(a));
  assert.equal(changed.passed, false);
  assert.ok(changed.image);
  assert.equal(
    comparePixels(same, PNG.sync.write(new PNG({ width: 21, height: 20 })))
      .passed,
    false,
  );
});

test("style scoping preserves nested selectors, root themes and animation references", () => {
  const css = scopeStyles(
    ':root[data-theme="dark"]{--color:black}button,input:not([disabled]){animation:spin 1s linear} @media(pointer:coarse){button{height:44px}} @keyframes spin{to{transform:rotate(360deg)}}',
  );
  assert.match(css, /\.af-scope\[data-theme="dark"\]/);
  assert.match(css, /:where\(\.af-scope\) button/);
  assert.match(css, /:where\(\.af-scope\) input:not\(\[disabled\]\)/);
  assert.match(css, /animation:af-spin 1s linear/);
  assert.match(css, /@keyframes af-spin\{to\{/);
});

// Feature imports must not force the rich editor's stylesheet on a shell-only host.
test("feature styles are complete, scoped and exclude unrelated editor rules", async () => {
  const { readFile } = await import("node:fs/promises");
  const shell = await readFile(
    new URL("../dist/shell.css", import.meta.url),
    "utf8",
  );
  const files = await readFile(
    new URL("../dist/files.css", import.meta.url),
    "utf8",
  );
  assert.ok(shell.includes(".af-scope"));
  assert.ok(shell.includes(".app-shell"));
  assert.ok(!shell.includes("--crepe-font-default"));
  assert.ok(files.includes("--crepe-font-default"));
});
