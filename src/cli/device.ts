import { agentPath, mau } from "./client.js";
import { yes, type Command } from "./command.js";

const devicePath = (id: string) => agentPath(mau, id) + "/device";

export const deviceCommands: Command[] = [
  { path: ["device", "list"], summary: "Your partners that are agents on a computer, each with whether a computer is paired and connected.",
    run: ({ client }) => client().get(mau + "/devices") },
  { path: ["device", "show"], args: "NAME", summary: "The computer paired with the partner: name, platform, kernel, whether it is connected and when it last was.",
    run: async ({ args, client }) => client().get(devicePath((await client().partner(args[0]!)).id)) },
  { path: ["device", "pair"], args: "NAME", summary: "A new pairing code and the command to run on the computer; the computer that pairs replaces the one paired before.",
    run: async ({ args, client }) => client().post(devicePath((await client().partner(args[0]!)).id) + "/pair") },
  { path: ["device", "remove"], args: "NAME", options: yes, summary: "End the partner's pairing: its computer is disconnected; the partner itself stays.",
    run: async ({ args, client }) => {
      const partner = await client().partner(args[0]!);
      await client().delete(devicePath(partner.id));
      return { removed: partner.name };
    } },
];
