import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

// Preserve upstream declarations and selector specificity. Only ownership changes.
export function scopeSelector(selector) {
  return selectorParser((selectors) => {
    selectors.each((item) => {
      let root = item.nodes.some(
        (node) => node.type === "class" && node.value === "af-scope",
      );
      item.walk((node) => {
        if (
          (node.type === "pseudo" && node.value === ":root") ||
          (node.type === "tag" && ["html", "body"].includes(node.value))
        ) {
          node.replaceWith(selectorParser.className({ value: "af-scope" }));
          root = true;
        }
      });
      if (!root) {
        item.prepend(selectorParser.combinator({ value: " " }));
        item.prepend(
          selectorParser.pseudo({
            value: ":where",
            nodes: [
              selectorParser.selector({
                nodes: [selectorParser.className({ value: "af-scope" })],
              }),
            ],
          }),
        );
      }
    });
  }).processSync(selector);
}

export function scopeStyles(css, names = new Map()) {
  const root = postcss.parse(css);
  root.walkAtRules(/keyframes$/, (rule) => {
    const name = rule.params;
    if (!names.has(name)) names.set(name, `af-${name}`);
    rule.params = names.get(name);
  });
  root.walkRules((rule) => {
    if (rule.parent.type === "atrule" && /keyframes$/.test(rule.parent.name))
      return;
    if (rule.parent.type === "rule") return; // Nested rules inherit the parent's boundary.
    rule.selector = scopeSelector(rule.selector);
  });
  root.walkDecls(/^(?:-webkit-)?animation(?:-name)?$/, (declaration) => {
    declaration.value = declaration.value.replace(
      /[\w-]+/g,
      (word) => names.get(word) ?? word,
    );
  });
  return root.toString();
}

/** Export one complete stylesheet for the page entry, without relying on consumer CSS tooling. */
export function scopedStyles() {
  return {
    name: "frontend-scoped-styles",
    enforce: "post",
    generateBundle(_, bundle) {
      const names = new Map();
      const styles = Object.values(bundle).filter(
        (file) => file.type === "asset" && file.fileName.endsWith(".css"),
      );
      for (const file of styles)
        postcss
          .parse(String(file.source))
          .walkAtRules(/keyframes$/, (rule) =>
            names.set(rule.params, `af-${rule.params}`),
          );
      for (const file of styles)
        file.source = scopeStyles(String(file.source), names);
      // Only the page entry carries a stylesheet; the application CSS files are copied as they are.
      const entry = Object.values(bundle).find(
        (file) => file.type === "chunk" && file.isEntry && file.name === "pages/index",
      );
      const files = new Set();
      const seen = new Set();
      function collect(chunk) {
        if (!chunk || chunk.type !== "chunk" || seen.has(chunk.fileName))
          return;
        seen.add(chunk.fileName);
        for (const imported of [...chunk.imports, ...chunk.dynamicImports])
          collect(bundle[imported]);
        for (const css of chunk.viteMetadata?.importedCss ?? [])
          files.add(css);
      }
      collect(entry);
      this.emitFile({
        type: "asset",
        fileName: "pages/pages.css",
        source: [...files]
          .map((name) => String(bundle[name]?.source ?? ""))
          .join("\n"),
      });
    },
  };
}
