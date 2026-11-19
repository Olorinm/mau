import { Client, mau } from "./client.js";
import type { Command } from "./command.js";

export const accountCommands: Command[] = [
  { path: ["login"], args: "URL", summary: "Sign in to a Mau service through Cloudflare Access and remember its URL.",
    run: ({ args, options, signal }) => Client.login(args[0]!, options, signal) },
  { path: ["logout"], summary: "Forget the remembered service.",
    run: async () => { Client.logout(); return { loggedOut: true }; } },
  { path: ["whoami"], summary: "The signed-in owner.",
    run: ({ client }) => client().get(mau + "/account") },
  { path: ["profiles"], summary: "The environment profiles you can create partners with.",
    run: ({ client }) => client().get(mau + "/options") },
];
