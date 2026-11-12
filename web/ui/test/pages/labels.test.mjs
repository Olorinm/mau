import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import ts from "typescript";

async function files(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((item) =>
        item.isDirectory() ? files(`${dir}/${item.name}`) : `${dir}/${item.name}`,
      ),
    )
  ).flat();
}

/** { language: { key: text } } from an exported object literal of string tables. */
async function tables(path) {
  const tree = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  const out = {};
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isObjectLiteralExpression(node.initializer) &&
      ts.isVariableDeclaration(node.parent.parent)
    ) {
      const table = (out[node.name.text] ??= {});
      for (const item of node.initializer.properties)
        if (ts.isPropertyAssignment(item) && ts.isStringLiteralLike(item.initializer))
          table[item.name.text] = item.initializer.text;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return out;
}

const restored = await tables("src/pages/presentation/restored-labels.ts");
const presentation = await tables("src/pages/presentation/labels.ts");
const languages = ["en", "zh-CN"];
const text = (language, key) =>
  restored[language]?.[key] ?? presentation[language]?.[key] ?? presentation.en?.[key];

test("every label key a component asks for has text in each language", async () => {
  const keys = new Map();
  const stages = ["source-upload", "candidate", "trusted-build", "registry", "local-finalization"];
  for (const path of (await files("src/pages")).filter((path) => /\.tsx?$/.test(path))) {
    const tree = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    function literals(node, into) {
      if (ts.isStringLiteralLike(node)) into.push(node.text);
      else if (ts.isConditionalExpression(node)) {
        literals(node.whenTrue, into);
        literals(node.whenFalse, into);
      } else if (ts.isParenthesizedExpression(node)) literals(node.expression, into);
      else if (ts.isTemplateExpression(node) && node.templateSpans.length === 1)
        for (const stage of stages) into.push(node.head.text + stage + node.templateSpans[0].literal.text);
    }
    function visit(node) {
      if (ts.isCallExpression(node) && node.arguments.length) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (name === "t") {
          const found = [];
          literals(node.arguments[0], found);
          for (const key of found) if (/^[a-zA-Z]+\.[\w.-]+$/.test(key)) keys.set(key, path);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  assert.ok(keys.size > 700, `only ${keys.size} label keys found`);
  const missing = [];
  for (const [key, path] of keys)
    for (const language of languages) if (text(language, key) === undefined) missing.push(`${language} ${key} (${path})`);
  assert.deepEqual(missing, []);
});

test("label text does not name a product", () => {
  const named = [];
  for (const table of [restored, presentation])
    for (const [language, entries] of Object.entries(table))
      for (const [key, value] of Object.entries(entries))
        if (/opengrove/i.test(value)) named.push(`${language} ${key}: ${value}`);
  assert.deepEqual(named, []);
});
