import { readFile, writeFile, readdir } from "node:fs/promises";
// CSS is an explicit consumer import, not a TypeScript module dependency.
async function clean(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    if (entry.isDirectory()) await clean(path);
    else if (entry.name.endsWith(".d.ts"))
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(
          /^import ['"][^'"]+\.css['"];\r?\n/gm,
          "",
        ),
      );
  }
}
await clean(new URL("../dist/", import.meta.url));
