import { copyFile, mkdir } from "node:fs/promises";
// The application stylesheets are plain CSS, exported as written (`./app.css` imports the others).
await mkdir(new URL("../dist/app/", import.meta.url), { recursive: true });
for (const name of ["app", "tokens", "components", "surfaces", "pixel-avatar"])
  await copyFile(
    new URL(`../src/app/${name}.css`, import.meta.url),
    new URL(`../dist/app/${name}.css`, import.meta.url),
  );
