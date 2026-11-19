import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { mau } from "./client.js";
import { fail, list, text, type Command } from "./command.js";

const scopes = ["chat", "approve", "manage"];
export const tokenCommands: Command[] = [
  { path: ["token", "create"], args: "NAME", summary: "Create an access token for an agent: with an Access service token of yours it may do what its scopes say, until it expires or you revoke it. The token is shown this once.",
    options: {
      scope: { type: "string", multiple: true, required: true, value: "SCOPE", help: "chat (talk to partners), approve (answer cards and approvals for you) or manage (partners, environments, memory, connectors, schedules); repeat for more. Every token reads." },
      days: { type: "string", value: "DAYS", help: "Days until the token expires: 1 to 90, 7 when not given." },
      out: { type: "string", value: "FILE", help: "Write the token to this new private file and leave it out of the output." } },
    run: async ({ args, options, client }) => {
      const days = text(options.days), out = text(options.out), chosen = list(options.scope);
      if (chosen.some(scope => !scopes.includes(scope))) fail("unknown_scope", { scopes });
      if (days !== undefined && !(/^[1-9][0-9]?$/.test(days) && Number(days) <= 90)) fail("invalid_days", { min: 1, max: 90 });
      // The file is taken before the token exists, so a token is never created that cannot be delivered.
      let file: number | undefined;
      if (out !== undefined) try { file = openSync(out, "wx", 0o600); } catch (error) {
        fail((error as NodeJS.ErrnoException).code === "EEXIST" ? "file_exists" : "file_not_writable", { file: out });
      }
      try {
        const { token, ...created } = await client().post(mau + "/tokens", { name: args[0], scopes: chosen, ...(days === undefined ? {} : { expiresInDays: Number(days) }) });
        if (file === undefined) return { ...created, token };
        if (typeof token !== "string") return fail("invalid_response");
        writeSync(file, token + "\n");
        return { ...created, tokenFile: out };
      } catch (error) {
        if (out !== undefined && file !== undefined) rmSync(out, { force: true });
        throw error;
      } finally { if (file !== undefined) closeSync(file); }
    } },
  { path: ["token", "list"], summary: "Your access tokens, newest first: id, name, scopes, expiry, last use and revocation; never the token itself.",
    run: ({ client }) => client().get(mau + "/tokens") },
  { path: ["token", "revoke"], args: "ID", summary: "Revoke an access token by its id; its next request is refused.",
    run: async ({ args, client }) => {
      await client().delete(`${mau}/tokens/${encodeURIComponent(args[0]!)}`);
      return { revoked: args[0] };
    } },
];
