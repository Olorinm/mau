import { resolve } from "node:path";
import { CloudflareError } from "./cloudflare.js";
import { systemRuntime, type Runtime } from "./effects.js";
import { DeployError } from "./source.js";
import { Directory, EMAIL, HOSTNAME, NAME, defaultDirectory, resources, type Deployment, type OwnerAction, type StepStatus } from "./state.js";
import { Context, STEPS, type DeployInput, type StepId } from "./steps.js";

/**
 * `not_run`: a step it needs has not finished. A dry run reports `in_place` (nothing to do) and `would_change`
 * (with the changes under `would`) where a run reports `skipped` and `done`.
 */
export interface StepReport { step: StepId; status: StepStatus | "not_run" | "in_place" | "would_change"; detail: unknown }
export interface DeployReport {
  ok: boolean;
  dryRun: boolean;
  name: string;
  url: string;
  directory: string;
  resources: { account?: string; worker: string; gateway: { worker: string; url?: string }; buckets: string[]; access?: { teamDomain: string } };
  steps: StepReport[];
  /** What a human must do, each with the command that goes on afterwards. */
  needsOwner: Array<OwnerAction & { step: StepId }>;
  /** Commands to run next: for the owner once the deployment stands, otherwise the one that continues it. */
  next: string[];
  notes: string[];
}
export interface DeployResult { exitCode: 0 | 1 | 2; report: DeployReport }

/** The record of a deployment: the one in its directory, or a new one from the flags of a first run. */
function recordFor(input: DeployInput, directory: Directory, name: string): Deployment {
  const existing = directory.load();
  const hostname = input.hostname?.trim().toLowerCase() ?? existing?.hostname, ownerEmail = input.ownerEmail?.trim().normalize("NFC").toLowerCase() ?? existing?.ownerEmail;
  if (!hostname) throw new DeployError("hostname_required", "this deployment has no hostname yet", "Pass --hostname mau.example.com (a hostname of a domain in the Cloudflare account).");
  if (!ownerEmail) throw new DeployError("owner_email_required", "this deployment has no owner yet", "Pass --owner-email with the address the owner signs in to Cloudflare Access with.");
  if (!HOSTNAME.test(hostname)) throw new DeployError("hostname_invalid", hostname);
  if (!EMAIL.test(ownerEmail)) throw new DeployError("owner_email_invalid", ownerEmail);
  // The hostname is the namespace of every account and partner id; an existing deployment cannot move.
  if (existing && existing.hostname !== hostname) throw new DeployError("hostname_differs_from_deployment", `${directory.path} is the deployment of ${existing.hostname}`, "Use another --name for another hostname.");
  if (existing && existing.name !== name) throw new DeployError("name_differs_from_deployment", `${directory.path} is the deployment named ${existing.name}`);
  return { ...(existing ?? { version: 1, name, steps: {} }), hostname, ownerEmail };
}

/**
 * Brings one Mau deployment to its complete state: every step checks what exists and makes what is missing, so the
 * same call continues after a failure or an owner's action and upgrades after `git pull`.
 * Exit code 0: complete and healthy. 2: an owner must act (`report.needsOwner`). 1: a step failed.
 */
export async function deploy(input: DeployInput, runtime: Runtime = systemRuntime()): Promise<DeployResult> {
  const name = input.name ?? "mau", dryRun = input.dryRun === true;
  const directory = new Directory(resolve(input.dir ?? defaultDirectory(runtime.env, runtime.home, name)));
  const report: DeployReport = { ok: false, dryRun, name, url: "", directory: directory.path, resources: { worker: name, gateway: { worker: `${name}-environment` }, buckets: [] },
    steps: [], needsOwner: [], next: [], notes: [] };
  const failure = (error: unknown): StepReport["detail"] => error instanceof DeployError ? { error: error.code, ...(error.detail ? { detail: error.detail } : {}), ...(error.fix ? { fix: error.fix } : {}) }
    : error instanceof CloudflareError ? { error: "cloudflare_request_failed", detail: error.message, ...(error.denied ? { fix: "The credentials lack a permission: docs/deployment.md#api-token" } : {}) }
    : { error: "unexpected_failure", detail: error instanceof Error ? error.message : String(error) };

  let context: Context;
  try {
    if (!NAME.test(name)) throw new DeployError("name_invalid", name, "A name is lower-case letters, digits and hyphens, at most 32, starting with a letter.");
    context = new Context(runtime, input, directory, recordFor(input, directory, name), dryRun);
  } catch (error) {
    report.steps.push({ step: "preflight", status: "failed", detail: failure(error) });
    runtime.progress(JSON.stringify(report.steps[0]));
    return { exitCode: 1, report };
  }
  const { record } = context, names = resources(name);
  report.url = `https://${record.hostname}`;
  const ended = new Map<StepId, StepReport["status"]>();
  for (const step of STEPS) {
    const waiting = step.needs.filter((id) => !["done", "skipped", "in_place"].includes(ended.get(id)!));
    // A dry run goes on past what it could only list, to list the rest; nothing goes on past a failure.
    if ([...ended.values()].includes("failed") || waiting.length && !(dryRun && ended.get("preflight") !== "needs_owner")) {
      ended.set(step.id, "not_run");
      report.steps.push({ step: step.id, status: "not_run", detail: { waitingFor: waiting.length ? waiting : [...ended].filter(([, status]) => status === "failed").map(([id]) => id) } });
      continue;
    }
    context.changes = []; context.detail = {};
    let entry: StepReport, owner: OwnerAction | void = undefined;
    try {
      owner = await step.run(context);
      entry = { step: step.id, status: owner ? "needs_owner" : context.changes.length ? (dryRun ? "would_change" : "done") : dryRun ? "in_place" : "skipped",
        detail: { ...context.detail, ...(context.changes.length ? { [dryRun ? "would" : "changed"]: context.changes } : {}), ...(owner ? { needs: owner } : {}) } };
    } catch (error) { entry = { step: step.id, status: "failed", detail: failure(error) }; }
    entry = JSON.parse(context.redact(JSON.stringify(entry))) as StepReport;
    ended.set(step.id, entry.status);
    if (!dryRun) {
      record.steps[step.id] = { status: entry.status as StepStatus, at: new Date().toISOString(), detail: entry.detail };
      // A deployment exists once preflight has accepted its hostname; before that nothing is kept, so a mistyped one can be corrected.
      if (step.id !== "preflight" || entry.status !== "failed" || directory.load()) context.save();
      runtime.progress(JSON.stringify(entry));
    }
    // The report names an owner's action once, under needsOwner.
    if (owner) { report.needsOwner.push({ step: step.id, ...owner }); entry = { ...entry, detail: { ...entry.detail as object, needs: owner.reason } }; }
    report.steps.push(entry);
  }
  const statuses = [...ended.values()];
  report.ok = statuses.every((status) => status === "done" || status === "skipped" || status === "in_place");
  report.resources = { ...(record.accountId ? { account: record.accountId } : {}), worker: names.worker, gateway: { worker: names.gateway, ...(record.gateway ? { url: record.gateway.url } : {}) },
    buckets: Object.values(names.buckets), ...(record.access ? { access: { teamDomain: record.access.teamDomain } } : {}) };
  report.notes = dryRun ? ["A dry run changes nothing. A step that is not in place lists under \"would\" what a run does."] : report.ok ? [
    ...context.notes,
    `${directory.path} holds this deployment's record, configuration and secrets. Keep it private; a later \`${context.continueWith()}\` upgrades from it.`,
    "Daily backup of Mau's own state is not configured: docs/deployment.md#daily-backup",
  ] : [];
  // One command continues after everything an owner was asked for: the base command with each action's flags.
  const base = context.continueWith(), flags = new Set(report.needsOwner.map((action) => action.continue.slice(base.length).trim()).filter(Boolean));
  report.next = dryRun ? [] : report.ok ? [`cloudflared access login ${report.url}`, `mau login ${report.url}`, "mau partner create NAME --profile codex", "mau chat send NAME \"hello\""]
    : [[base, ...flags].join(" ")];
  return { exitCode: statuses.includes("failed") ? 1 : report.needsOwner.length ? 2 : 0, report: JSON.parse(context.redact(JSON.stringify(report))) as DeployReport };
}
