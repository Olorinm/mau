#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
const safe = (name) => {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name))
    throw new Error(`Invalid artifact name: ${name}`);
  return name;
};

export function comparePixels(
  before,
  after,
  { threshold = 0.1, maxDiffRatio = 0.002 } = {},
) {
  const a = PNG.sync.read(before),
    b = PNG.sync.read(after);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      passed: false,
      reason: `Dimensions changed: ${a.width}×${a.height} → ${b.width}×${b.height}`,
    };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold,
  });
  const ratio = pixels / (a.width * a.height);
  return {
    passed: ratio <= maxDiffRatio,
    pixels,
    ratio,
    maxDiffRatio,
    image: PNG.sync.write(diff),
  };
}

function reportHtml(report) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI comparison</title><style>
body{font:15px/1.6 system-ui;margin:24px;color:#242424;background:#fafafa}h1{font-size:24px}article{margin:24px 0;padding:20px;background:white;border:1px solid #ddd;border-radius:12px}.images{display:flex;gap:16px;overflow:auto}figure{margin:0;flex:1;min-width:240px}img{display:block;max-width:100%;border:1px solid #eee}summary{cursor:pointer}pre{white-space:pre-wrap}.pass{color:#087331}.fail{color:#bc1822}small{color:#666}table{border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #ddd;padding:8px}
</style><h1>UI comparison · <span class="${report.passed ? "pass" : "fail"}">${report.passed ? "PASS" : "FAIL"}</span></h1>
<p>${escape(report.description ?? "")}</p><p>Reference: ${escape(report.targets[0].label)} · Candidate: ${escape(report.targets[1].label)}</p>
<small>${escape(report.generatedAt)} · ${escape(report.browser)}. Screenshots and checks cover only the listed scenarios. Informational captures do not pass a visual gate.</small>
${report.scenarios
  .map(
    (
      s,
    ) => `<article><h2>${escape(s.name)} · ${s.viewport.width}×${s.viewport.height}</h2>
${s.runs.map((run) => `<details ${run.error ? "open" : ""}><summary class="${run.passed ? "pass" : "fail"}">${escape(run.target)} · ${run.passed ? "PASS" : "FAIL"}</summary><ul>${run.checks.map((c) => `<li class="${c.passed ? "pass" : "fail"}">${escape(c.name)}${c.error ? ": " + escape(c.error) : ""}</li>`).join("")}</ul>${run.error ? `<pre>${escape(run.error)}</pre>` : ""}<pre>${escape(run.errors.join("\n"))}</pre></details>`).join("")}
${s.comparisons
  .map(
    (c) =>
      `<h3>${escape(c.name)} · <span class="${c.passed ? "pass" : "fail"}">${c.informational ? "REVIEW ONLY" : c.passed ? "PASS" : "FAIL"}</span></h3><p>${escape(c.reason ?? (c.ratio === undefined ? "" : `${(c.ratio * 100).toFixed(3)}% changed; limit ${c.maxDiffRatio * 100}%`))}</p>${c.masks?.length ? `<p>Masks: ${escape(c.masks.map((m) => `${m.selector}: ${m.reason}`).join("; "))}</p>` : ""}<div class="images">${[
        ["Reference", c.before],
        ["Candidate", c.after],
        ["Difference", c.diff],
      ]
        .filter(([, path]) => path)
        .map(
          ([label, path]) =>
            `<figure><figcaption>${label}</figcaption><a href="${escape(path)}"><img src="${escape(path)}" loading="lazy"></a></figure>`,
        )
        .join("")}</div>`,
  )
  .join("")}
</article>`,
  )
  .join("")}</html>`;
}

/** Config is ordinary JavaScript: target setup plus shared workflows, no product assumptions. */
export async function compareUI(config, output) {
  if (config.targets?.length !== 2 || !config.scenarios?.length)
    throw new Error("Provide exactly two targets and at least one scenario.");
  if (
    new Set(config.scenarios.map((s) => s.name)).size !==
    config.scenarios.length
  )
    throw new Error("Scenario names must be unique.");
  output = resolve(output);
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = {
    description: config.description,
    generatedAt: new Date().toISOString(),
    browser: browser.version(),
    targets: config.targets.map(({ label, url, revision }) => ({
      label,
      url,
      revision,
    })),
    scenarios: [],
    passed: true,
  };
  try {
    for (const scenario of config.scenarios) {
      safe(scenario.name);
      const result = {
        name: scenario.name,
        viewport: scenario.viewport ?? { width: 1280, height: 800 },
        runs: [],
        comparisons: [],
      };
      for (const [index, target] of config.targets.entries()) {
        const context = await browser.newContext({
          viewport: result.viewport,
          locale: config.locale ?? "zh-CN",
          colorScheme: scenario.colorScheme ?? "light",
          reducedMotion: "reduce",
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(config.timeout ?? 15000);
        const run = {
          target: target.label,
          checks: [],
          captures: [],
          errors: [],
          passed: true,
        };
        page.on("pageerror", (error) => run.errors.push(error.message));
        const check = async (name, assertion) => {
          try {
            await assertion();
            run.checks.push({ name, passed: true });
          } catch (error) {
            run.checks.push({ name, passed: false, error: error.message });
            throw error;
          }
        };
        const capture = async (name, options = {}) => {
          safe(name);
          if (run.captures.some((c) => c.name === name))
            throw new Error(`Duplicate capture: ${name}`);
          const masks = options.masks ?? [];
          if (masks.some((m) => !m.selector || !m.reason))
            throw new Error("Every mask requires a selector and a reason.");
          for (const mask of masks)
            if (!(await page.locator(mask.selector).count()))
              throw new Error(`Mask does not match: ${mask.selector}`);
          await page.evaluate(() => document.fonts.ready);
          const locator = options.selector
            ? page.locator(options.selector)
            : page;
          const file = `${scenario.name}-${index}-${name}.png`;
          await locator.screenshot({
            path: join(output, file),
            animations: "disabled",
            caret: "hide",
            mask: masks.map((m) => page.locator(m.selector)),
            maskColor: "#d8d8d8",
            ...(options.selector ? {} : { fullPage: true }),
          });
          run.captures.push({
            name,
            file,
            masks,
            selector: options.selector,
            informational: options.informational ?? false,
            maxDiffRatio: options.maxDiffRatio ?? config.maxDiffRatio ?? 0.002,
          });
        };
        try {
          if (config.fixedTime)
            await page.clock.setFixedTime(new Date(config.fixedTime));
          await target.setup?.({ page, context, scenario });
          await page.goto(target.url);
          await target.ready?.({ page, context, scenario });
          await scenario.run({ page, context, target, check, capture });
          if (!run.checks.length || !run.captures.length)
            throw new Error(
              "Each scenario must include assertions and captures.",
            );
          if (run.errors.length) throw new Error("Uncaught browser error(s).");
        } catch (error) {
          run.error = error.stack ?? error.message;
          run.passed = false;
          await page
            .screenshot({
              path: join(output, `${scenario.name}-${index}-failure.png`),
            })
            .catch(() => {});
        } finally {
          await context.close();
        }
        result.runs.push(run);
      }
      const [before, after] = result.runs;
      if (
        JSON.stringify(before.checks.map((c) => c.name)) !==
        JSON.stringify(after.checks.map((c) => c.name))
      ) {
        after.passed = false;
        after.errors.push(
          "The two targets did not execute the same interaction checks.",
        );
      }
      for (const name of new Set(
        [...before.captures, ...after.captures].map((c) => c.name),
      )) {
        const a = before.captures.find((c) => c.name === name),
          b = after.captures.find((c) => c.name === name);
        const comparison = {
          name,
          before: a?.file,
          after: b?.file,
          masks: a?.masks,
          passed: false,
        };
        if (!a || !b) comparison.reason = "Missing capture on one target.";
        else if (
          JSON.stringify([a.masks, a.maxDiffRatio, a.informational]) !==
          JSON.stringify([b.masks, b.maxDiffRatio, b.informational])
        )
          comparison.reason = "Comparison rules differ between targets.";
        else {
          const { image, ...pixels } = comparePixels(
            await readFile(join(output, a.file)),
            await readFile(join(output, b.file)),
            { maxDiffRatio: a.maxDiffRatio },
          );
          Object.assign(comparison, pixels);
          if (image) {
            comparison.diff = `${scenario.name}-${name}-diff.png`;
            await writeFile(join(output, comparison.diff), image);
          }
          if (a.informational) {
            comparison.informational = true;
            comparison.passed = true;
          }
        }
        result.comparisons.push(comparison);
      }
      result.passed =
        result.runs.every((r) => r.passed) &&
        result.comparisons.every((c) => c.passed);
      report.passed &&= result.passed;
      report.scenarios.push(result);
      console.log(`${result.passed ? "PASS" : "FAIL"} ${scenario.name}`);
    }
  } finally {
    await browser.close();
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(output, "index.html"), reportHtml(report));
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [configPath, output = "comparison-report"] = process.argv.slice(2);
  if (!configPath)
    throw new Error(
      "Usage: node tools/ui-compare.mjs config.mjs [output-directory]",
    );
  const { default: config } = await import(
    pathToFileURL(resolve(configPath)).href
  );
  const report = await compareUI(config, output);
  console.log(`Report: ${resolve(output, "index.html")}`);
  process.exitCode = report.passed ? 0 : 1;
}
