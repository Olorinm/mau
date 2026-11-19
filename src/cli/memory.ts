import { agentPath, mau } from "./client.js";
import type { Command, Invocation } from "./command.js";

const memory = async ({ args, client }: Invocation) => agentPath(mau, (await client().partner(args[0]!)).id) + "/memory";
const change = (operation: (args: string[]) => Record<string, string>) => async (invocation: Invocation) =>
  invocation.client().post(await memory(invocation), operation(invocation.args));

export const memoryCommands: Command[] = [
  { path: ["memory", "show"], args: "NAME", summary: "The partner's memory: its entries and how much of the limit they use.",
    run: async invocation => invocation.client().get(await memory(invocation)) },
  { path: ["memory", "add"], args: "NAME TEXT", summary: "Add an entry to the partner's memory.",
    run: change(args => ({ action: "add", content: args[1]! })) },
  { path: ["memory", "replace"], args: "NAME OLD_TEXT TEXT", summary: "Replace the one entry that contains OLD_TEXT.",
    run: change(args => ({ action: "replace", old_text: args[1]!, content: args[2]! })) },
  { path: ["memory", "remove"], args: "NAME OLD_TEXT", summary: "Remove the one entry that contains OLD_TEXT.",
    run: change(args => ({ action: "remove", old_text: args[1]! })) },
  { path: ["memory", "log"], args: "NAME", summary: "The last changes of the partner's memory, newest first, each with its id.",
    run: async invocation => invocation.client().get(await memory(invocation) + "/mutations") },
  { path: ["memory", "undo"], args: "NAME MUTATION_ID", summary: "Take one change of the memory back.",
    run: async invocation => invocation.client().post(`${await memory(invocation)}/mutations/${encodeURIComponent(invocation.args[1]!)}/undo`) },
];
