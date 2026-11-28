// Opt-in native audit. Run with the official Codex executable and a version listed below.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { CodexRestrictedMemoryReviewer, REVIEW_DESTRUCTIVE_WRITES, codexReviewProfile, reviewProfileDigest } from "../dist/restricted-memory-reviewer.js";

const [command, version] = process.argv.slice(2);
const supported = ["0.165.0", "0.171.0"];
if (!command || !isAbsolute(command) || !supported.includes(version)) {
  throw new Error("Usage: node scripts/audit-restricted-reviewer.mjs /absolute/path/to/codex 0.165.0|0.171.0");
}

const positive = "memory_probe";
const unavailable = ["exec_command", "apply_patch", "collaboration.spawn_agent", "exec", "list_mcp_resources", "view_image", "send_message_to_user_async"];
const temporary = await mkdtemp(join(tmpdir(), "mau-review-audit-"));
const cwd = join(temporary, "workspace"), home = join(temporary, "home"), codexHome = join(temporary, "codex");
const profile = codexReviewProfile({ id: "review-audit", cwd, home, codexHome, command });
const token = randomBytes(32).toString("hex");
let scenario, totalRequests = 0, totalDispatches = 0, host, hostExit;
class AuditError extends Error {}
function check(condition, message) { if (!condition) throw new AuditError(message); }

// Only the registered, harmless tool may be present before the fixture returns a call.
const provider = createServer(async (request, response) => {
  try {
    check(request.method === "POST" && request.url === "/v1/responses", "unexpected provider route");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const input = JSON.parse(request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes);
    check(scenario && input.model === profile.thread.model, "unexpected model");
    check(input.tools?.length === 1 && input.tools[0].type === "function" && input.tools[0].name === positive, "tool catalog mismatch");
    scenario.requests++;
    totalRequests++;
    check(scenario.requests <= 2, "unexpected additional model request");
    const id = String(totalRequests), callId = "call_" + scenario.index;
    let item;
    if (scenario.requests === 1) {
      item = { type: "function_call", id: "fc_" + id, call_id: callId, name: scenario.tool, arguments: "{}", status: "completed" };
    } else {
      const result = input.input.find(item => item.type === "function_call_output" && item.call_id === callId);
      const expected = scenario.tool === positive ? "memory-fixture-ok" : "unsupported call: " + scenario.tool;
      check(result?.output === expected, "native tool result mismatch");
      item = { type: "message", id: "msg_" + id, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Audit complete.", annotations: [] }] };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event("response.created", { response: { id: "resp_" + id, status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id: "resp_" + id, status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  } catch (error) {
    if (scenario) scenario.error = error instanceof AuditError ? error : new AuditError("invalid provider request");
    response.writeHead(400).end();
  }
});

try {
  for (const dir of [home, codexHome, cwd]) await mkdir(dir, { mode: 0o700 });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const template = await readFile(new URL("../examples/restricted-review-provider.toml", import.meta.url), "utf8");
  const marker = 'base_url = "https://api.openai.com/v1"';
  check(template.includes(marker), "dedicated provider template changed");
  await writeFile(join(codexHome, "config.toml"), template.replace(marker, `base_url = "http://127.0.0.1:${provider.address().port}/v1"`), { mode: 0o600 });
  const config = join(temporary, "host.json");
  await writeFile(config, JSON.stringify({ stateDirectory: join(temporary, "state"), host: "127.0.0.1", port: 0, runtimes: [profile] }));
  const tokenFile = join(temporary, "host-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  // The web checkout installs the public Host CLI from Mau's pinned .packages archive.
  const cli = fileURLToPath(new URL("../web/node_modules/.bin/agent-host", import.meta.url));
  host = spawn(process.execPath, [cli, "serve", "--config", config, "--token-file", tokenFile], {
    cwd, env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: home, CODEX_HOME: codexHome,
      MAU_REVIEW_API_KEY: "local-fixture", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  hostExit = once(host, "exit");
  const started = new Promise(resolve => {
    createInterface({ input: host.stdout }).on("line", line => {
      const match = /^Agent Host listening at (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (match) resolve(match[1]);
    });
  });
  const base = await Promise.race([started, hostExit.then(() => undefined), delay(10_000, undefined, { ref: false })]);
  check(base, "Host startup failed");
  async function api(path, body) {
    const response = await fetch(base + "/v1" + path, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(10_000),
      headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    check(response.ok, "Host request failed");
    return response.json();
  }
  const scope = { owner: "fixture-owner", agentId: "fixture-agent" };
  const sessions = { owner: scope.owner, agentId: "fixture-worker", runtimeId: profile.id, discover: () => api("/runtimes/discover", { runtimeId: profile.id }),
    host: { nativeRequest: async (runtimeId, method, params) => (await api("/runtimes/native", { runtimeId, method, params })).result } };
  const installed = { profileDigest: reviewProfileDigest(profile), modelCatalog: "bundled-" + version, homeIsolation: "dedicated-private", toolBinding: {
    enforcement: "server-dispatch-allowlist", memory: { scope, tool: positive, origin: "review", destructiveWrites: REVIEW_DESTRUCTIVE_WRITES },
    skills: { mode: "unavailable" }, allowedTools: [positive], otherTools: "denied", delivery: "disabled", recursion: "disabled" } };
  const reviewer = new CodexRestrictedMemoryReviewer({ resolve: async () => ({ partner: scope, sessions, profile, installed }) });
  const proof = await reviewer.capabilities(scope, AbortSignal.timeout(15_000));
  check(proof.status === "available", "native version, provider or reviewer capabilities mismatch");
  for (const [index, tool] of [positive, ...unavailable].entries()) {
    scenario = { index, tool, requests: 0, dispatched: false };
    const run = await api("/runs", { sessionId: "audit-" + index, runtimeId: profile.id, input: "Read the synthetic review fixture.",
      tools: [{ name: positive, description: "Read the synthetic review fixture.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
    const limit = Date.now() + 20_000;
    while (true) {
      if (scenario.error) throw scenario.error;
      check(Date.now() < limit, "run timed out");
      const { calls } = await api(`/runs/${run.id}/calls`);
      for (const call of calls) {
        check(tool === positive && call.name === positive, "unexpected tool reached product dispatch");
        if (scenario.dispatched) {
          check(call.id === scenario.callId, "duplicate managed call");
          continue;
        }
        await api(`/runs/${run.id}/calls/${call.id}/result`, { result: { success: true, contentItems: [{ type: "inputText", text: "memory-fixture-ok" }] } });
        scenario.dispatched = true;
        scenario.callId = call.id;
        totalDispatches++;
      }
      const record = await api(`/runs/${run.id}`);
      if (record.status === "completed") break;
      check(["queued", "running"].includes(record.status), "run did not complete");
      await delay(15);
    }
    check(scenario.requests === 2 && scenario.dispatched === (tool === positive), "unexpected scenario counts");
  }
  console.log(JSON.stringify({ version, scenarios: 1 + unavailable.length, providerRequests: totalRequests,
    advertisedTools: [positive], managedCalls: totalDispatches, nativeRefusals: unavailable.length, capabilities: proof.status }));
} catch (error) {
  console.error(error instanceof AuditError ? error.message : "Native audit failed. Check the documented prerequisites.");
  process.exitCode = 1;
} finally {
  if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
  if (hostExit) await hostExit;
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
