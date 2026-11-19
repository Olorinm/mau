import { agentPath, mau, router, secretFile, type Client } from "./client.js";
import { commaList, fail, noWait, text, yes, type Command, type Invocation } from "./command.js";

const kinds = ["feishu", "weixin", "telegram", "grove-mail"];
const running = ["starting", "waiting", "application", "telegram_pairing", "binding"];
const isJob = (value: any) => typeof value?.state === "string" && typeof value?.expiresAt === "string";
const jobPath = (agentId: string, jobId: string) => `${agentPath(router, agentId)}/connection-jobs/${encodeURIComponent(jobId)}`;
const connectionPath = (agentId: string, connectionId: string) => `${agentPath(router, agentId)}/connections/${encodeURIComponent(connectionId)}`;

/** What the owner has to do for a connection job, when it waits for a person. */
function needsOwner(name: string, job: any) {
  if (job.state === "pairing") return { needsOwner: { action: "enter_pairing_code", command: `mau channel pair ${name} ${job.id} --code-file FILE` } };
  if (job.url && job.state !== "ready" && job.state !== "failed") return { needsOwner: { action: "open_link", url: job.url as string } };
  return {};
}
/**
 * Follow a connection job: its consent link (and QR code) go to stderr once, and the job is read until it is ready,
 * waits for a pairing code, fails or expires. With `--no-wait` it is read only until there is something to hand to
 * the owner.
 */
async function follow(client: Client, name: string, agentId: string, job: any, { options, note }: Invocation) {
  let shown = "";
  for (;;) {
    if (job.url && shown !== job.url) {
      let link: URL | undefined;
      try { link = new URL(job.url); } catch { link = undefined; }
      if (link?.protocol !== "https:" || /[\x00-\x1f\x7f-\x9f]/.test(job.url)) fail("invalid_consent_url");
      note(job.url);
      if (typeof job.qr === "string") note(job.qr.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
      shown = job.url;
    }
    if (job.state === "failed") {
      const error = typeof job.error === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(job.error) ? job.error : "connection_setup_failed";
      const recovery = job.recovery;
      // Feishu: the app exists but setup did not finish. Authorizing that app again is the way on.
      const command = recovery ? ["mau channel connect", name, "feishu", "--app-id",
        typeof recovery.appId === "string" && /^cli_[a-zA-Z0-9_]{1,128}$/.test(recovery.appId) ? recovery.appId : "APP_ID",
        ...(recovery.domain === "lark" ? ["--domain lark"] : [])].join(" ") : undefined;
      return fail(error, { job, ...(command ? { recover: command } : {}) });
    }
    if (job.state === "ready" || job.state === "pairing") return { ...job, ...needsOwner(name, job) };
    if (!running.includes(job.state)) return fail("invalid_connection_job", { job });
    if (options["no-wait"] && (job.url || job.state !== "starting")) return { ...job, ...needsOwner(name, job) };
    if (!(Date.parse(job.expiresAt) > Date.now())) return fail("connection_job_expired", { job });
    await client.wait(2000);
    job = await client.get(jobPath(agentId, job.id));
  }
}

export const channelCommands: Command[] = [
  { path: ["channel", "list"], args: "NAME", summary: "The partner's channel connections, each with the result of checking it now.",
    run: async ({ args, client }) => {
      const partner = await client().partner(args[0]!);
      const { checks } = await client().post(agentPath(router, partner.id) + "/check", {}, 120_000) as { checks: Array<{ connectionId?: string; kind: string; status: string; detail: string }> };
      return { data: (partner.summary.connections as Array<{ id: string; kind: string }>).map(connection => {
        const check = checks.find(item => item.connectionId === connection.id);
        return { ...connection, ...(check ? { status: check.status, detail: check.detail } : {}) };
      }), checks: checks.filter(check => !check.connectionId) };
    } },
  { path: ["channel", "connect"], args: "NAME KIND", summary: `Connect a channel (${kinds.join(", ")}) to the partner; waits for the owner's consent where the channel needs it.`,
    options: {
      domain: { type: "string", value: "feishu|lark", help: "feishu: which service; feishu when not given." },
      "app-id": { type: "string", value: "cli_...", help: "feishu: authorize an app that already exists instead of creating one." },
      "bot-token-file": { type: "string", value: "FILE", help: "telegram: the file with the bot token." },
      "mail-service": { type: "string", value: "ID", help: "grove-mail: the mail service." },
      inbox: { type: "string", value: "ID", help: "grove-mail: the inbox." },
      "owner-email": { type: "string", value: "EMAIL", help: "grove-mail: your own address." },
      "api-key-file": { type: "string", value: "FILE", help: "grove-mail: the file with the API key." },
      ...noWait },
    run: async invocation => {
      const { args, options, client } = invocation, kind = args[1]!, appId = text(options["app-id"]), domain = text(options.domain);
      if (!kinds.includes(kind)) fail("unknown_channel", { kinds });
      if ((appId !== undefined || domain !== undefined) && kind !== "feishu") fail("option_requires_feishu");
      if (appId !== undefined && !/^cli_[a-zA-Z0-9_]{1,128}$/.test(appId)) fail("invalid_feishu_app_id");
      if (domain !== undefined && domain !== "feishu" && domain !== "lark") fail("invalid_feishu_domain");
      const body = kind === "feishu" ? { kind, domain: domain ?? "feishu", ...(appId ? { appId } : {}) }
        : kind === "telegram" ? { kind, token: secretFile(text(options["bot-token-file"]), "bot_token_file_required") }
        : kind === "grove-mail" ? { kind, serviceId: text(options["mail-service"]) ?? fail("mail_service_required"), inboxId: text(options.inbox) ?? fail("inbox_required"),
            ownerEmail: text(options["owner-email"]) ?? fail("owner_email_required"), apiKey: secretFile(text(options["api-key-file"]), "api_key_file_required") }
        : { kind };
      const partner = await client().partner(args[0]!), started = await client().post(agentPath(router, partner.id) + "/connections", body, 120_000);
      // A channel that needs no consent is connected at once and answers with the partner's connections.
      return isJob(started) ? follow(client(), partner.name, partner.id, started, invocation) : started;
    } },
  { path: ["channel", "disconnect"], args: "NAME CONNECTION_ID", options: yes, summary: "Remove one channel connection of the partner.",
    run: async ({ args, options, client }) => {
      if (!options.yes) fail("confirm_with_yes");
      return client().delete(connectionPath((await client().partner(args[0]!)).id, args[1]!), 120_000);
    } },
  { path: ["channel", "access"], args: "NAME CONNECTION_ID", summary: "Who else may talk to the partner through a connection: the groups and the people. Without options: show; an option replaces its list.",
    options: {
      groups: { type: "string", value: "ID,ID", help: "Replace the allowed groups; an empty value allows none." },
      peers: { type: "string", value: "ADDRESS,ADDRESS", help: "Replace the allowed people; an empty value allows none." } },
    run: async ({ args, options, client }) => {
      const path = connectionPath((await client().partner(args[0]!)).id, args[1]!) + "/access", groups = text(options.groups), peers = text(options.peers);
      const current = await client().get(path);
      if (groups === undefined && peers === undefined) return current;
      return client().put(path, { groupIds: groups === undefined ? current.groupIds : commaList(groups), peerAddresses: peers === undefined ? current.peerAddresses : commaList(peers) });
    } },
  { path: ["channel", "jobs"], args: "NAME", summary: "The partner's recent connection jobs.",
    run: async ({ args, client }) => client().get(agentPath(router, (await client().partner(args[0]!)).id) + "/connection-jobs") },
  { path: ["channel", "job"], args: "NAME JOB_ID", options: noWait, summary: "Follow one connection job until it is ready, waits for a pairing code, fails or expires.",
    run: async invocation => {
      const { args, client } = invocation, partner = await client().partner(args[0]!);
      return follow(client(), partner.name, partner.id, await client().get(jobPath(partner.id, args[1]!)), invocation);
    } },
  { path: ["channel", "pair"], args: "NAME JOB_ID", summary: "Give a connection job the pairing code its channel showed you.",
    options: { "code-file": { type: "string", value: "FILE", help: "The file with the pairing code." } },
    run: async ({ args, options, client }) => {
      const code = secretFile(text(options["code-file"]), "code_file_required");
      await client().post(jobPath((await client().partner(args[0]!)).id, args[1]!) + "/pairing", { code });
      return { paired: true };
    } },
];
