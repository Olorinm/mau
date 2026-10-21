#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { privateFile } from "./files.js";
import { runSsh } from "./ssh-client.js";

const help = `Mau — your agent product

  mau login --url URL --token-file FILE
  mau login --url URL --user MATRIX_ID --password-file FILE
  mau options
  mau setup NAME --environment PROFILE [--workspace ID]
  mau workspaces | workspace-create NAME
  mau agents | use NAME | status | check
  mau environment-create PROFILE [--workspace ID]
  mau environment-replace PROFILE | environment-rollback
  mau pause | resume | destroy | reconcile
  mau ssh NAME [-- COMMAND...]
  mau channel-connect matrix|feishu|weixin|telegram|grove-mail
  mau channel-jobs | channel-job ID | channel-pair ID --pairing-code-file FILE
  mau channel-auth CONNECTION [status|begin|complete]

Options: --no-wait, --allow-http (loopback development only),
  --bot-token-file FILE, --domain feishu|lark, --messaging-only,
  --app-id cli_... (authorize an existing Feishu/Lark app),
  --mail-service ID, --inbox ID, --owner-email EMAIL, --api-key-file FILE
Credentials and selection are saved in ~/.config/mau/session.json.
Router owns accounts and connections; Mau owns environment operations.
`;
const options = {
  help: { type: "boolean" }, version: { type: "boolean" }, url: { type: "string" },
  user: { type: "string" }, "password-file": { type: "string" }, "token-file": { type: "string" },
  environment: { type: "string" }, "no-wait": { type: "boolean" }, "allow-http": { type: "boolean" },
  workspace: { type: "string" },
  "app-id": { type: "string" }, "bot-token-file": { type: "string" }, domain: { type: "string" }, "messaging-only": { type: "boolean" },
  "mail-service": { type: "string" }, inbox: { type: "string" }, "owner-email": { type: "string" },
  "api-key-file": { type: "string" }, "pairing-code-file": { type: "string" },
} as const;
const stateFile = join(process.env.MAU_CONFIG_DIR ?? join(homedir(), ".config", "mau"), "session.json");
interface Session { url: string; token: string; owner: string; agentId?: string }
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const fail = (code: string): never => { throw new Error(code); };
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
function secret(path: string | undefined): string {
  if (!path) return fail("credential_file_required");
  const value = readFileSync(path, "utf8").trim();
  if (!value || value.length > 16384) return fail("invalid_credential_file");
  return value;
}
function endpoint(raw: string, allowHTTP: boolean): string {
  const u = new URL(raw);
  if (u.username || u.password || u.hash || u.search || u.pathname !== "/" ||
      !(u.protocol === "https:" || allowHTTP && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    return fail("invalid_service_url");
  return u.origin;
}
async function request(base: string, path: string, token: string | undefined, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit",
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) return fail(typeof data.error === "string" && /^[a-z0-9_]+$/.test(data.error) ? data.error : "request_failed");
  return data;
}
async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  const [command, ...args] = positionals;
  if (values.version) { output({ product: "mau", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version }); return; }
  if (values.help || !command) { process.stdout.write(help); return; }
  const arity: Record<string, [number, number]> = { login: [0, 0], options: [0, 0], setup: [1, 1], agents: [0, 0],
    use: [1, 1], status: [0, 0], check: [0, 0], "environment-create": [1, 1], pause: [0, 0], resume: [0, 0],
    destroy: [0, 0], reconcile: [0, 0], ssh: [1, Infinity], "channel-connect": [1, 1], "channel-jobs": [0, 0], "channel-job": [1, 1], "channel-pair": [1, 1], "channel-auth": [1, 2] };
  arity["environment-replace"] = [1, 1]; arity["environment-rollback"] = [0, 0];
  arity.workspaces = [0, 0]; arity["workspace-create"] = [1, 1];
  const count = arity[command];
  if (!count || args.length < count[0] || args.length > count[1]) fail("invalid_command_arguments");
  if (values.environment && command !== "setup") fail("environment_option_requires_setup");
  if (values.workspace && !["setup", "environment-create"].includes(command)) fail("workspace_option_requires_environment");
  if (values["app-id"] !== undefined) {
    if (command !== "channel-connect" || args[0] !== "feishu") fail("app_id_requires_feishu_channel_connect");
    if (!/^cli_[a-zA-Z0-9_]{1,128}$/.test(values["app-id"])) fail("invalid_feishu_app_id");
  }
  const allowHTTP = values["allow-http"] ?? false;
  if (command === "login") {
    if (!values.url) fail("url_required");
    const url = endpoint(values.url!, allowHTTP);
    let token: string;
    if (values["token-file"]) {
      if (values.user || values["password-file"]) fail("choose_one_login_method");
      token = secret(values["token-file"]);
    } else {
      if (!values.user || !values["password-file"]) fail("user_and_password_file_required");
      const info = await request(url, "/_mau/v1/info", undefined);
      const homeserver = endpoint(info.homeserver, allowHTTP);
      const session = await request(homeserver, "/_matrix/client/v3/login", undefined, {
        type: "m.login.password", identifier: { type: "m.id.user", user: values.user },
        password: secret(values["password-file"]), initial_device_display_name: "Mau",
      });
      if (typeof session.access_token !== "string") fail("invalid_login_response");
      token = session.access_token;
    }
    const account = await request(url, "/_mau/v1/account", token);
    if (typeof account.owner !== "string") fail("invalid_account_response");
    privateFile(stateFile, { url, token, owner: account.owner });
    output({ owner: account.owner, url }); return;
  }
  let session: Session;
  try { session = JSON.parse(readFileSync(stateFile, "utf8")); } catch { return fail("login_required"); }
  const url = endpoint(session.url, allowHTTP);
  if (values.url && endpoint(values.url, allowHTTP) !== url) fail("login_to_selected_service_first");
  const product = (path: string, body?: unknown) => request(url, "/_mau/v1" + path, session.token, body);
  const routing = (path: string, body?: unknown) => request(url, "/_agent-router/v1" + path, session.token, body);
  const select = (id: string) => { session.agentId = id; privateFile(stateFile, session); };
  const pollEnvironment = async (id: string, status: any) => {
    const deadline = Date.now() + 15 * 60_000;
    while (status.busy && !values["no-wait"]) {
      if (Date.now() > deadline) fail("environment_pending_check_status");
      await delay(1000, undefined, { signal: controller.signal });
      status = await product(`/agents/${encodeURIComponent(id)}/environment`);
    }
    if (status.error || status.state === "needs_action") {
      output(status); fail("environment_needs_action");
    }
    return status;
  };
  if (command === "options") { output(await product("/options")); return; }
  if (command === "workspaces") { output(await product("/workspaces")); return; }
  if (command === "workspace-create") { output(await product("/workspaces", { name: args[0] })); return; }
  if (command === "agents") { output(await product("/agents")); return; }
  if (command === "ssh") {
    const list = await product("/agents");
    const agent = list.data.find((a: any) => a.agent.name === args[0]);
    if (!agent) fail("agent_not_found");
    process.exitCode = await runSsh(url, session.token, agent.agent.id,
      publicKey => product(`/agents/${encodeURIComponent(agent.agent.id)}/ssh`, { publicKey }), args.slice(1), controller.signal);
    return;
  }
  if (command === "use") {
    const list = await product("/agents");
    const selected = list.data.find((a: any) => a.agent.name === args[0]);
    if (!selected) fail("agent_not_found");
    select(selected.agent.id); output(selected); return;
  }
  if (command === "setup") {
    if (!values.environment) fail("environment_profile_required");
    const result = await product("/agents", { name: args[0], profileId: values.environment, ...(values.workspace ? { workspaceId: values.workspace } : {}) });
    select(result.agent.id);
    await pollEnvironment(result.agent.id, result.environment);
    output(await product(`/agents/${encodeURIComponent(result.agent.id)}`)); return;
  }
  if (!session.agentId) fail("select_an_agent_first");
  const path = `/agents/${encodeURIComponent(session.agentId!)}`;
  if (command === "status") { output(await product(path)); return; }
  if (command === "check") { output(await routing(path + "/check", {})); return; }
  if (["environment-replace", "environment-rollback"].includes(command)) {
    const current = await product(path + "/environment");
    const status = await product(path + "/environment/" + (command === "environment-replace" ? "replace" : "rollback"), {
      expectedOperationId: current.operationId, ...(command === "environment-replace" ? { profileId: args[0] } : {}),
    });
    output(await pollEnvironment(session.agentId!, status)); return;
  }
  if (["environment-create", "pause", "resume", "destroy", "reconcile"].includes(command)) {
    const target = command === "environment-create" ? "" : "/" + command;
    const status = await product(path + "/environment" + target, command === "environment-create" ? { profileId: args[0], ...(values.workspace ? { workspaceId: values.workspace } : {}) } : {});
    output(await pollEnvironment(session.agentId!, status)); return;
  }
  const pollConnection = async (job: any) => {
    let shown = "";
    if (job?.id) process.stderr.write(`Connection job: ${JSON.stringify(job.id)} — inspect with channel-jobs or channel-job ID\n`);
    while (job?.state) {
      if (job.url && shown !== job.url) {
        const u = new URL(job.url);
        if (u.protocol !== "https:" || /[\x00-\x1f\x7f-\x9f]/.test(job.url)) fail("invalid_consent_url");
        process.stderr.write(job.url + "\n");
        if (typeof job.qr === "string") process.stderr.write(job.qr.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") + "\n");
        shown = job.url;
      }
      if (job.state === "failed") {
        output(job);
        if (job.recovery) {
          const recovery = job.recovery;
          let command = "mau channel-connect feishu";
          if (typeof recovery.appId === "string" && /^cli_[a-zA-Z0-9_]{1,128}$/.test(recovery.appId)) command += " --app-id " + recovery.appId;
          else if (recovery.action === "authorize_existing_app") command += " --app-id APP_ID";
          if (recovery.domain === "lark") command += " --domain lark";
          if (recovery.personalTools === false) command += " --messaging-only";
          process.stderr.write("Recover the selected Agent with: " + command + "\n");
        }
        fail(typeof job.error === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(job.error) ? job.error : "connection_setup_failed");
      }
      if (job.state === "ready" || job.state === "pairing" || values["no-wait"]) return job;
      if (!["starting", "waiting", "application", "authorization", "telegram_pairing", "binding"].includes(job.state)) fail("invalid_connection_job");
      if (!(Date.parse(job.expiresAt) > Date.now())) {
        output(job); process.stderr.write("Inspect channel-jobs for the final result and recovery instructions.\n");
        fail("connection_job_expired");
      }
      await delay(2000, undefined, { signal: controller.signal });
      job = await routing(path + "/connection-jobs/" + encodeURIComponent(job.id));
    }
    return job;
  };
  if (command === "channel-jobs") { output(await routing(path + "/connection-jobs")); return; }
  if (command === "channel-job") { output(await pollConnection(await routing(path + "/connection-jobs/" + encodeURIComponent(args[0]!)))); return; }
  if (command === "channel-pair") {
    output(await routing(path + "/connection-jobs/" + encodeURIComponent(args[0]!) + "/pairing", { code: secret(values["pairing-code-file"]) })); return;
  }
  if (command === "channel-auth") {
    const action = args[1] ?? "status";
    if (!["status", "begin", "complete"].includes(action)) fail("invalid_authorization_action");
    output(await routing(path + "/communication/connections/" + encodeURIComponent(args[0]!) + "/authorization" + (action === "status" ? "" : "/" + action), action === "status" ? undefined : {})); return;
  }
  if (command === "channel-connect") {
    const kind = args[0];
    let body: Record<string, unknown> = { kind };
    if (kind === "feishu") body = { kind, domain: values.domain ?? "feishu", personalTools: !values["messaging-only"], ...(values["app-id"] ? { appId: values["app-id"] } : {}) };
    else if (kind === "telegram") body.token = secret(values["bot-token-file"]);
    else if (kind === "grove-mail") body = { kind, serviceId: values["mail-service"], inboxId: values.inbox,
      ownerEmail: values["owner-email"], apiKey: secret(values["api-key-file"]) };
    else if (kind !== "matrix" && kind !== "weixin") fail("unknown_channel");
    output(await pollConnection(await routing(path + "/connections", body))); return;
  }
}
main().catch(error => {
  process.stderr.write(controller.signal.aborted ? "interrupted\n" :
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message + "\n" : "operation_failed\n");
  process.exitCode = 1;
});
