import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

// Test the real CLI: a new screenshot baseline must never silently accept regressions.
const server = createServer((request, response) => {
  const mode = new URL(request.url, "http://localhost").pathname;
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<style>button{width:200px;height:100px;background:${mode === "/visual" ? "red" : "white"}}</style><button onclick="${mode === "/interaction" ? "" : "this.textContent='Done'"}">Run</button>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const directory = await mkdtemp(join(tmpdir(), "ui-compare-self-test-"));
try {
  for (const [mode, expected] of [
    ["same", 0],
    ["visual", 1],
    ["interaction", 1],
  ]) {
    const config = join(directory, `${mode}.mjs`);
    await writeFile(
      config,
      `export default {timeout:1500,targets:[{label:'Reference',url:'${url}/same'},{label:'Candidate',url:'${url}/${mode}'}],scenarios:[{name:'button',viewport:{width:400,height:300},run:async({page,check,capture})=>{await page.locator('button').click();await check('click changes the label',async()=>{if(await page.locator('button').innerText()!=='Done')throw Error('Click did not work');});await capture('button',{selector:'button'});}}]};`,
    );
    const reportDirectory = join(directory, mode);
    const status = await new Promise((resolveStatus, reject) => {
      const child = spawn(
        process.execPath,
        [resolve("tools/ui-compare.mjs"), config, reportDirectory],
        { stdio: "pipe" },
      );
      let errors = "";
      child.stderr.on("data", (chunk) => (errors += chunk));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== expected) console.error(errors);
        resolveStatus(code);
      });
    });
    assert.equal(status, expected, `${mode}: CLI exit status`);
    const report = JSON.parse(
      await readFile(join(reportDirectory, "report.json"), "utf8"),
    );
    assert.equal(report.passed, expected === 0);
    assert.match(
      await readFile(join(reportDirectory, "index.html"), "utf8"),
      /Reference/,
    );
    if (mode === "visual")
      assert.equal(report.scenarios[0].comparisons[0].passed, false);
    if (mode === "interaction")
      assert.equal(report.scenarios[0].runs[1].checks[0].passed, false);
  }
  console.log(
    "Comparison CLI accepts identical UI and rejects injected pixel and interaction regressions.",
  );
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}
