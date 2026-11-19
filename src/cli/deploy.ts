import { type Command, type Option, type OptionValues } from "./command.js";

const name: Record<string, Option> = {
  name: { type: "string", value: "NAME", help: "The deployment; the prefix of everything it owns (default: mau)." },
  dir: { type: "string", value: "DIR", help: "The deployment's private directory (default: ~/.config/mau/deployments/NAME)." },
};
/** The options that were given, under the names the deployment code uses. An absent option stays absent. */
const given = (options: OptionValues, names: Record<string, string>) => Object.fromEntries(
  Object.entries(names).flatMap(([option, key]) => options[option] === undefined ? [] : [[key, options[option]]]));

// Deploy and doctor report with their exit code as well: 2 when the owner has something to do, 1 when a check fails.
export const deployCommands: Command[] = [
  { path: ["deploy"], summary: "Deploy your own Mau to your Cloudflare account, or continue or upgrade the deployment NAME. Run it again after any failure. Exit code 2: the result lists what the owner must do by hand.",
    options: {
      hostname: { type: "string", value: "HOSTNAME", help: "Where Mau is served: a hostname of a domain in the account (first run)." },
      "owner-email": { type: "string", value: "EMAIL", help: "The address the owner signs in to Cloudflare Access with (first run)." },
      ...name,
      "codex-auth": { type: "string", value: "FILE", help: "The owner's Codex sign-in (default: ~/.codex/auth.json)." },
      "dry-run": { type: "boolean", help: "Print what would be made; change nothing." },
      "r2-access-key-id-file": { type: "string", value: "FILE", help: "An R2 access key ID made by hand, when the credentials cannot make one." },
      "r2-secret-access-key-file": { type: "string", value: "FILE", help: "Its secret access key." },
      "access-team-domain": { type: "string", value: "URL", help: "https://TEAM.cloudflareaccess.com of an Access application made by hand." },
      "access-audience": { type: "string", value: "TAG", help: "Its audience tag." },
    },
    run: async ({ options }) => {
      const { deploy } = await import("../deploy/index.js");
      const { exitCode, report } = await deploy(given(options, { hostname: "hostname", "owner-email": "ownerEmail", name: "name", dir: "dir",
        "codex-auth": "codexAuth", "dry-run": "dryRun", "r2-access-key-id-file": "r2AccessKeyIdFile",
        "r2-secret-access-key-file": "r2SecretAccessKeyFile", "access-team-domain": "accessTeamDomain", "access-audience": "accessAudience" }));
      process.exitCode = exitCode;
      return report;
    } },
  { path: ["doctor"], summary: "Check this machine, the deployment NAME and, signed in, the running service. Every failed check says how to fix it. Exit code 1 when a check fails.",
    options: { ...name, url: { type: "string", value: "URL", help: "Also check the running service at URL (default: the deployment's)." } },
    run: async ({ options }) => {
      const { doctor } = await import("../deploy/index.js");
      const { exitCode, report } = await doctor(given(options, { name: "name", dir: "dir", url: "url" }));
      process.exitCode = exitCode;
      return report;
    } },
];
