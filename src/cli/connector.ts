import { agentPath, mau, type Client } from "./client.js";
import { assignments, fail, list, noWait, text, yes, type Command } from "./command.js";

const accounts = mau + "/connector-accounts";
const accountPath = (id: string) => `${accounts}/${encodeURIComponent(id)}`;
async function account(client: Client, id: string) {
  const listed = await client.get(accounts, 95_000) as { data: Array<{ id: string; kind: string; state: string }> };
  return listed.data.find(item => item.id === id) ?? fail("connector_account_not_found", { id });
}
/** Add or take away one connection in what a partner can use, starting from what it can use now. */
async function assign(client: Client, id: string, name: string, change: (connections: string[]) => string[]) {
  await account(client, id);
  const path = agentPath(mau, (await client.partner(name)).id) + "/connectors";
  return client.put(path, { connections: change((await client.get(path)).connections) }, 95_000);
}

export const connectorCommands: Command[] = [
  { path: ["connector", "list"], summary: "Your connector connections (Gmail, Feishu personal access, browser …) with their authorization state and the partners that can use each.",
    run: ({ client }) => client().get(accounts, 95_000) },
  { path: ["connector", "show"], args: "ID", summary: "One connector connection.",
    run: ({ args, client }) => account(client(), args[0]!) },
  { path: ["connector", "connect"], args: "ID", summary: "Authorize a connector connection. Feishu personal access prints a consent link and waits for you to confirm it; OAuth connections are authorized in the web console.",
    options: { partner: { type: "string", value: "NAME", help: "Feishu: first give the connection the app of this partner's Feishu chat channel." }, ...noWait },
    run: async ({ args, options, client, note }) => {
      const id = args[0]!, found = await account(client(), id), partner = text(options.partner);
      if (partner !== undefined) {
        if (found.kind !== "feishu") fail("partner_option_requires_feishu");
        await client().post(accountPath(id) + "/feishu-application", { agentId: (await client().partner(partner)).id }, 150_000);
      }
      const reply = await client().call("POST", accountPath(id) + "/connect", {}, 150_000);
      let state = client().result(reply);
      if (state.state === "connected" || !state.authorizationUrl) return state;
      // The service bound this consent to the browser that asked for it (a cookie on its OAuth callback). The CLI is
      // not that browser, so the provider's redirect would be refused: the owner starts it in the console instead.
      if (reply.headers.getSetCookie().some(cookie => cookie.startsWith("mau_oauth_")))
        return fail("connector_consent_requires_console", { id, needsOwner: { action: "connect_in_console", url: client().url + "/?view=connectors" } });
      note(state.authorizationUrl);
      const needsOwner = { action: "open_link", url: state.authorizationUrl as string };
      if (options["no-wait"]) return { ...state, needsOwner };
      // Device consent (Feishu) is finished by asking the service; any other consent shows in the account's state.
      while (state.state !== "connected") {
        if (state.expiresAt && !(Date.parse(state.expiresAt) > Date.now())) fail("connector_consent_expired", { id });
        if (!["authorization_required", "authorization_pending"].includes(state.state)) fail("connector_consent_failed", { id, account: state });
        await client().wait(4000);
        state = await client().post(`${accountPath(id)}/${found.kind === "feishu" ? "complete" : "check"}`, {}, 150_000);
      }
      return state;
    } },
  { path: ["connector", "check"], args: "ID", summary: "The connection's authorization state now.",
    run: ({ args, client }) => client().post(accountPath(args[0]!) + "/check", {}, 150_000) },
  { path: ["connector", "disconnect"], args: "ID", options: yes, summary: "Remove the connection's authorization; connecting again needs your consent.",
    run: ({ args, client }) => client().post(accountPath(args[0]!) + "/disconnect", {}, 150_000) },
  { path: ["connector", "assign"], args: "ID NAME", summary: "Let the partner use the connection. A partner that used another partner's connections gets a list of its own.",
    run: ({ args, client }) => assign(client(), args[0]!, args[1]!, connections => [...new Set([...connections, args[0]!])]) },
  { path: ["connector", "unassign"], args: "ID NAME", summary: "Stop the partner from using the connection.",
    run: async ({ args, client }) => {
      const result = await assign(client(), args[0]!, args[1]!, connections => connections.filter(connection => connection !== args[0]));
      // A partner in a shared environment that is left with no list of its own uses the other partner's again.
      if (result.connections.includes(args[0])) fail("connector_inherited", { id: args[0], inheritedFrom: result.inheritedFrom });
      return result;
    } },
  { path: ["connector", "policy"], args: "ID", summary: "The connection's operations and your setting for each; --set changes settings, --reset returns all to their defaults.",
    options: { set: { type: "string", multiple: true, value: "OPERATION=allow|ask|deny", help: "Set one operation; OPERATION is an id from this command's output." },
      reset: { type: "boolean", help: "Return every operation to its default." } },
    run: async ({ args, options, client }) => {
      const settings = Object.fromEntries(assignments(list(options.set), "invalid_setting")), path = accountPath(args[0]!) + "/policy";
      if (options.reset && Object.keys(settings).length) fail("choose_set_or_reset");
      for (const [operation, setting] of Object.entries(settings))
        if (!["allow", "ask", "deny"].includes(setting)) fail("invalid_setting", { operation, settings: ["allow", "ask", "deny"] });
      if (options.reset) return client().post(path + "/reset");
      return Object.keys(settings).length ? client().put(path, { settings }) : client().get(path);
    } },
  { path: ["connector", "sites"], args: "ID", summary: "A browser connection's site access: whether new sites open directly or ask you first, and the sites always allowed.",
    options: { mode: { type: "string", value: "direct|ask", help: "Open new sites directly, or ask first." },
      remove: { type: "string", multiple: true, value: "HOST", help: "Take one site out of the always-allowed ones." } },
    run: async ({ args, options, client }) => {
      const path = accountPath(args[0]!) + "/access", mode = text(options.mode);
      if (mode !== undefined && mode !== "direct" && mode !== "ask") fail("invalid_mode", { modes: ["direct", "ask"] });
      let access = mode === undefined && !list(options.remove).length ? await client().get(path) : undefined;
      if (mode !== undefined) access = await client().put(path, { webAccess: mode });
      for (const site of list(options.remove)) access = await client().put(path, { remove: site });
      return access;
    } },
];
