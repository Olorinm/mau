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

const labels = await tables("src/pages/presentation/labels.ts");
const languages = ["en", "zh-CN"];
const text = (language, key) => labels[language]?.[key];

test("every label key a component asks for has text in each language", async () => {
  const keys = new Map();
  for (const path of (await files("src/pages")).filter((path) => /\.tsx?$/.test(path))) {
    const tree = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    function literals(node, into) {
      if (ts.isStringLiteralLike(node)) into.push(node.text);
      else if (ts.isConditionalExpression(node)) {
        literals(node.whenTrue, into);
        literals(node.whenFalse, into);
      } else if (ts.isParenthesizedExpression(node)) literals(node.expression, into);
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
  assert.ok(keys.size > 100, `only ${keys.size} label keys found`);
  const missing = [];
  for (const [key, path] of keys)
    for (const language of languages) if (text(language, key) === undefined) missing.push(`${language} ${key} (${path})`);
  assert.deepEqual(missing, []);
});

test("every label is one a component can ask for, in both languages", async () => {
  const mentioned = new Set();
  // The chat components under src/ take their text from the same table through the shared chat provider.
  for (const path of (await files("src")).filter((path) => /\.tsx?$/.test(path) && !path.endsWith("presentation/labels.ts"))) {
    const tree = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    (function visit(node) {
      if (ts.isStringLiteralLike(node)) mentioned.add(node.text);
      ts.forEachChild(node, visit);
    })(tree);
  }
  const unused = Object.keys(labels.en).filter((key) => !mentioned.has(key));
  assert.deepEqual(unused, []);
  assert.deepEqual(Object.keys(labels["zh-CN"]).sort(), Object.keys(labels.en).sort());
});

test("label text does not name a product", () => {
  const named = [];
  for (const [language, entries] of Object.entries(labels))
    for (const [key, value] of Object.entries(entries))
      if (/opengrove/i.test(value)) named.push(`${language} ${key}: ${value}`);
  assert.deepEqual(named, []);
});
