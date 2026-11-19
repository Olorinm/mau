// `mau deploy` and `mau doctor`: one command that brings up a deployment, one that says what is missing or broken.
import { parseArgs } from "node:util";
import { deploy } from "./deploy.js";
import { doctor } from "./doctor.js";
import type { DeployInput } from "./steps.js";
import type { DoctorInput } from "./doctor.js";

export { deploy, type DeployReport, type DeployResult, type StepReport } from "./deploy.js";
export { doctor, type Check, type DoctorInput, type DoctorResult } from "./doctor.js";
export type { DeployInput } from "./steps.js";
export { systemRuntime, type Effects, type Runtime } from "./effects.js";

export const deployHelp = `mau deploy [--hostname HOSTNAME --owner-email EMAIL] [--name NAME] [--dir DIR] [--dry-run]
  Deploys Mau to your Cloudflare account, or continues or upgrades the deployment NAME (default: mau).
  --hostname HOSTNAME   where Mau is served; a hostname of a domain in the account (first run)
  --owner-email EMAIL   the address the owner signs in to Cloudflare Access with (first run)
  --codex-auth FILE     the owner's Codex sign-in (default: ~/.codex/auth.json)
  --dry-run             print what would be made; change nothing
  When the Cloudflare credentials cannot do a step, deploy says what to do by hand and takes the result:
  --r2-access-key-id-file FILE --r2-secret-access-key-file FILE
  --access-team-domain https://TEAM.cloudflareaccess.com --access-audience AUDIENCE_TAG
  Credentials: CLOUDFLARE_API_TOKEN, otherwise the local wrangler login. See docs/deployment.md.
`;
export const doctorHelp = `mau doctor [--name NAME | --dir DIR] [--url URL]
  Checks this machine, the deployment NAME (default: mau) and, signed in to Cloudflare Access, the running service.
  Prints one JSON document; exit code 1 when a check fails.
`;

const text = { type: "string" } as const;
/** Leaves out what was not given, so an absent flag stays absent. */
const given = <T extends object>(values: T) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

export function parseDeployArgs(args: string[]): DeployInput {
  const { values } = parseArgs({ args, options: { hostname: text, "owner-email": text, name: text, dir: text, "codex-auth": text, "dry-run": { type: "boolean" },
    "r2-access-key-id-file": text, "r2-secret-access-key-file": text, "access-team-domain": text, "access-audience": text } });
  return given({ hostname: values.hostname, ownerEmail: values["owner-email"], name: values.name, dir: values.dir, codexAuth: values["codex-auth"], dryRun: values["dry-run"],
    r2AccessKeyIdFile: values["r2-access-key-id-file"], r2SecretAccessKeyFile: values["r2-secret-access-key-file"],
    accessTeamDomain: values["access-team-domain"], accessAudience: values["access-audience"] });
}
export function parseDoctorArgs(args: string[]): DoctorInput {
  const { values } = parseArgs({ args, options: { name: text, dir: text, url: text } });
  return given(values);
}

/** `mau deploy ARGS`: progress on stderr, the report on stdout. Returns the process exit code. */
export async function runDeploy(args: string[]): Promise<number> {
  const { exitCode, report } = await deploy(parseDeployArgs(args));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return exitCode;
}
/** `mau doctor ARGS`: the checks on stdout. Returns the process exit code. */
export async function runDoctor(args: string[]): Promise<number> {
  const { exitCode, report } = await doctor(parseDoctorArgs(args));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return exitCode;
}
