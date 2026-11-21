import { agentPath, mau, router } from "./client.js";
import { assignments, fail, list, noWait, text, yes, type Command } from "./command.js";
import { settled } from "./environment.js";

export const partnerCommands: Command[] = [
  { path: ["partner", "list"], summary: "Your partners, each with its kind, channel connections, duty, kernel and environment or computer.",
    run: ({ client }) => client().get(mau + "/agents") },
  { path: ["partner", "show"], args: "NAME", summary: "One partner.",
    run: async ({ args, client }) => (await client().partner(args[0]!)).summary },
  { path: ["partner", "create"], args: "NAME", summary: "Create a partner with an environment of its own (--profile), in another partner's environment (--share), or as an agent on your computer (--external).",
    options: {
      profile: { type: "string", value: "ID", help: "An environment profile from `mau profiles`: the partner gets its own environment." },
      share: { type: "string", value: "PARTNER", help: "The partner whose environment the new one runs in." },
      kernel: { type: "string", value: "KERNEL", help: "With --share: the kernel to run on, when not the environment's main one." },
      external: { type: "boolean", help: "The partner is an agent already installed on your computer; the result has the pairing code and the command to run there." },
      duty: { type: "string", value: "TEXT", help: "One line saying what the partner is responsible for." },
      ...noWait },
    run: async ({ args, options, client }) => {
      const profileId = text(options.profile), share = text(options.share), kernel = text(options.kernel), duty = text(options.duty);
      if ([profileId, share, options.external].filter(Boolean).length !== 1) fail("choose_profile_share_or_external");
      if (kernel && !share) fail("kernel_requires_share");
      // The service answers a second request for the same name with the partner that exists; here that is a mistake.
      const partners = await client().partners();
      if (partners.some(partner => partner.name === args[0])) fail("partner_exists", { name: args[0] });
      const holder = share === undefined ? undefined : partners.find(partner => partner.name === share) ?? fail("partner_not_found", { name: share });
      const environment = options.external ? { kind: "external" } : holder ? { shareWith: holder.id, ...(kernel ? { kernel } : {}) } : { profileId };
      const created = await client().post(mau + "/agents", { name: args[0], ...environment, ...(duty ? { duty } : {}) });
      // The pairing code is shown once, here; `mau device pair` makes another.
      if (created.pairing) return created;
      if (created.environment) await settled(client(), created.agent.id, created.environment, options);
      return client().get(agentPath(mau, created.agent.id));
    } },
  { path: ["partner", "edit"], args: "NAME", summary: "Edit the name or duty of an existing partner.",
    options: {
      name: { type: "string", value: "NAME", help: "The new partner name." },
      duty: { type: "string", value: "TEXT", help: "One line describing the partner. An empty string clears it." },
    },
    run: async ({ args, options, client }) => {
      const name = text(options.name), duty = text(options.duty);
      if (name === undefined && duty === undefined) fail("profile_change_required");
      const partner = await client().partner(args[0]!);
      return client().request("PATCH", agentPath(mau, partner.id), { name, duty: duty === "" ? null : duty });
    } },
  { path: ["partner", "delete"], args: "NAME", options: yes, summary: "Permanently delete a partner with its environment or pairing, memory, schedules and channel connections.",
    run: async ({ args, client }) => {
      const partner = await client().partner(args[0]!);
      await client().delete(agentPath(mau, partner.id), 300_000);
      return { deleted: partner.name };
    } },
  { path: ["partner", "dismiss"], args: "NAME", summary: "Archive a partner: it keeps everything and leaves the roster.",
    run: async ({ args, client }) => client().post(agentPath(mau, (await client().partner(args[0]!)).id) + "/dismiss") },
  { path: ["partner", "restore"], args: "NAME", summary: "Bring a dismissed partner back.",
    run: async ({ args, client }) => client().post(agentPath(mau, (await client().partner(args[0]!)).id) + "/restore") },
  { path: ["partner", "check"], args: "NAME", summary: "Check the partner's host and channel connections now.",
    run: async ({ args, client }) => client().post(agentPath(router, (await client().partner(args[0]!)).id) + "/check", {}, 120_000) },
  { path: ["partner", "model"], args: "NAME", summary: "The models and efforts the partner's kernel offers and your selection; --set changes the selection.",
    options: { set: { type: "string", multiple: true, value: "KEY=VALUE", help: "KEY is model or effort; an empty VALUE returns it to the runtime's default." } },
    run: async ({ args, options, client }) => {
      const change: Record<string, string | null> = {};
      for (const [key, value] of assignments(list(options.set), "invalid_setting")) {
        if (key !== "model" && key !== "effort") fail("unknown_setting", { setting: key, settings: ["model", "effort"] });
        change[key] = value || null;
      }
      const path = agentPath(mau, (await client().partner(args[0]!)).id) + "/model-settings";
      return Object.keys(change).length ? client().put(path, change, 45_000) : client().get(path, 45_000);
    } },
];
