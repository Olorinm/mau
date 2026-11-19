#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { accountCommands } from "./cli/account.js";
import { apiCommands } from "./cli/api.js";
import { channelCommands } from "./cli/channel.js";
import { chatCommands } from "./cli/chat.js";
import { accessOptions, Client } from "./cli/client.js";
import { arity, CliError, fail, usage, type Command, type OptionValues } from "./cli/command.js";
import { connectorCommands } from "./cli/connector.js";
import { environmentCommands } from "./cli/environment.js";
import { memoryCommands } from "./cli/memory.js";
import { partnerCommands } from "./cli/partner.js";

/** Every command. Help and dispatch read this table and nothing else. */
const commands: Command[] = [
  ...accountCommands,
  ...partnerCommands,
  ...environmentCommands,
  ...chatCommands,
  ...memoryCommands,
  ...channelCommands,
  ...connectorCommands,
  ...apiCommands,
];

const nouns = [...new Set(commands.map(command => command.path[0]))];
function help(noun?: string): string {
  const shown = noun ? commands.filter(command => command.path[0] === noun) : commands;
  const entry = (command: Command) => [`  ${usage(command)}`, `      ${command.summary}`,
    ...(noun ? Object.entries(command.options ?? {}).map(([name, option]) => `      --${name}: ${option.help}`) : [])];
  return [
    "Mau: command-line client for a Mau service. A partner is always named by its NAME.", "",
    ...shown.flatMap(entry), "",
    ...(noun ? [] : ["  mau help | mau --help | mau NOUN --help | mau --version", ""]),
    "Output: one JSON document on stdout. Progress, links and QR codes go to stderr. On failure the exit code is 1 and",
    'the last stderr line is one JSON object: {"error":"<code>", ...}. Nothing is asked interactively.',
    "Every command also takes the Cloudflare Access credential options:",
    ...Object.entries(accessOptions).map(([name, option]) => `  --${name} ${option.value}: ${option.help}`),
    ...(noun ? [] : ["Options of one group of commands: mau NOUN --help (" + nouns.join(", ") + ")."]), "",
  ].join("\n");
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

async function main(argv: string[]): Promise<void> {
  const [first, second] = argv;
  if (first === "--version") { process.stdout.write(JSON.stringify({ product: "mau", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version }, null, 2) + "\n"); return; }
  if (first === undefined || first === "--help" || first === "help") {
    const noun = first === "help" ? second : undefined;
    if (noun !== undefined && !nouns.includes(noun)) fail("unknown_command", { commands: nouns });
    process.stdout.write(help(noun)); return;
  }
  const group = commands.filter(command => command.path[0] === first);
  if (!group.length) fail("unknown_command", { commands: nouns });
  if (argv.includes("--help") && !argv.slice(0, argv.indexOf("--help")).includes("--")) { process.stdout.write(help(first)); return; }
  const command = group.find(item => item.path.length === 1) ?? group.find(item => item.path[1] === second)
    ?? fail("unknown_command", { usage: group.map(usage) });
  let parsed: { values: OptionValues; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv.slice(command.path.length), allowPositionals: true, strict: true,
      options: Object.fromEntries(Object.entries({ ...accessOptions, ...command.options }).map(([name, option]) =>
        [name, { type: option.type, ...(option.multiple ? { multiple: true } : {}) }])) }) as typeof parsed;
  } catch (error) { return fail("invalid_arguments", { message: error instanceof Error ? error.message : String(error), usage: usage(command) }); }
  const count = arity(command);
  if (parsed.positionals.length < count.min || parsed.positionals.length > count.max) fail("invalid_arguments", { usage: usage(command) });
  let client: Client | undefined;
  const result = await command.run({ args: parsed.positionals, options: parsed.values, signal: controller.signal,
    client: () => client ??= Client.session(parsed.values, controller.signal),
    note: line => process.stderr.write(line + "\n") });
  if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const failure = controller.signal.aborted ? { error: "interrupted" }
    : error instanceof CliError ? { error: error.code, ...error.fields }
    : { error: "operation_failed", message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(JSON.stringify(failure) + "\n");
  process.exitCode = 1;
});
