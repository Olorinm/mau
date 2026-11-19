import { runSsh } from "../ssh-client.js";
import { agentPath, mau, type Client } from "./client.js";
import { fail, noWait, text, yes, type Command, type Invocation, type Option } from "./command.js";

const profile: Record<string, Option> = { profile: { type: "string", value: "ID", required: true, help: "An environment profile from `mau profiles`." } };
const environmentPath = (id: string) => agentPath(mau, id) + "/environment";

/** Wait until the environment is no longer busy (at most 15 minutes), unless `--no-wait`. One that needs action is a failure. */
export async function settled(client: Client, id: string, status: any, options: Invocation["options"]) {
  const deadline = Date.now() + 15 * 60_000;
  while (status.busy && !options["no-wait"]) {
    if (Date.now() > deadline) fail("environment_still_busy", { environment: status });
    await client.wait(1000);
    status = await client.get(environmentPath(id));
  }
  if (status.error || status.state === "needs_action") fail("environment_needs_action", { environment: status });
  return status;
}
const action = (name: "pause" | "resume" | "reconcile" | "destroy", summary: string): Command => ({
  path: ["env", name], args: "NAME", options: { ...(name === "destroy" ? yes : {}), ...noWait }, summary,
  run: async ({ args, options, client }) => {
    const partner = await client().partner(args[0]!);
    return settled(client(), partner.id, await client().post(`${environmentPath(partner.id)}/${name}`), options);
  },
});

export const environmentCommands: Command[] = [
  { path: ["env", "show"], args: "NAME", summary: "The state of the partner's environment.",
    run: async ({ args, client }) => client().get(environmentPath((await client().partner(args[0]!)).id)) },
  { path: ["env", "create"], args: "NAME", options: { ...profile, ...noWait }, summary: "Create an environment for a partner that has none.",
    run: async ({ args, options, client }) => {
      const profileId = text(options.profile), partner = await client().partner(args[0]!);
      return settled(client(), partner.id, await client().post(environmentPath(partner.id), { profileId }), options);
    } },
  action("pause", "Pause the partner's environment; messages do not wake it."),
  action("resume", "Resume a paused environment."),
  action("reconcile", "Check an interrupted or uncertain environment operation against the cloud."),
  action("destroy", "Destroy the partner's environment; the partner itself stays."),
  { path: ["env", "replace"], args: "NAME", options: { ...profile, ...noWait }, summary: "Move the partner to a new environment of another profile.",
    run: async ({ args, options, client }) => {
      const profileId = text(options.profile), partner = await client().partner(args[0]!);
      const current = await client().get(environmentPath(partner.id));
      return settled(client(), partner.id, await client().post(environmentPath(partner.id) + "/replace", { profileId, expectedOperationId: current.operationId }), options);
    } },
  { path: ["env", "rollback"], args: "NAME", options: noWait, summary: "Return the partner to the environment it had before `env replace`.",
    run: async ({ args, options, client }) => {
      const partner = await client().partner(args[0]!), current = await client().get(environmentPath(partner.id));
      return settled(client(), partner.id, await client().post(environmentPath(partner.id) + "/rollback", { expectedOperationId: current.operationId }), options);
    } },
  { path: ["ssh"], args: "NAME [-- COMMAND...]", summary: "Open a shell in the partner's environment, or run COMMAND there; exits with its status and prints no JSON.",
    run: async ({ args, client, signal }) => {
      const partner = await client().partner(args[0]!);
      process.exitCode = await runSsh(client().url, client().headers(), partner.id,
        publicKey => client().post(agentPath(mau, partner.id) + "/ssh", { publicKey }), args.slice(1), signal);
      return undefined;
    } },
];
