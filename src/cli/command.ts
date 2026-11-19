import type { Client } from "./client.js";

/** A failure the CLI reports as its last stderr line: `{"error": code, ...fields}`, exit code 1. */
export class CliError extends Error {
  constructor(readonly code: string, readonly fields: Record<string, unknown> = {}) { super(code); }
}
export const fail = (code: string, fields?: Record<string, unknown>): never => { throw new CliError(code, fields); };

export interface Option {
  type: "string" | "boolean";
  /** The option can be given more than once. */
  multiple?: true;
  /** What the value is, as usage shows it: `--profile ID`. */
  value?: string;
  help: string;
}
export type OptionValues = Record<string, string | boolean | string[] | undefined>;
export interface Invocation {
  /** Positional arguments, in the order of the command's `args`. */
  args: string[];
  options: OptionValues;
  /** The signed-in service. Reading the session and the Access credentials happens on first use. */
  client(): Client;
  /** A progress line, link or QR code for a person, on stderr. */
  note(line: string): void;
  signal: AbortSignal;
}
/** One command: the words that select it, what it takes and what it does. Usage text and dispatch both read this. */
export interface Command {
  /** `["partner", "create"]`, or one word for a top-level command. */
  path: [string] | [string, string];
  /** Positional arguments: `NAME`, `[NAME]` when optional, `COMMAND...` for the rest of the line. */
  args?: string;
  options?: Record<string, Option>;
  summary: string;
  /** The result, printed as the one JSON document on stdout; `undefined` prints nothing. */
  run(invocation: Invocation): Promise<unknown>;
}

export const noWait: Record<string, Option> = { "no-wait": { type: "boolean", help: "Return at once instead of waiting for the operation to finish." } };
export const yes: Record<string, Option> = { yes: { type: "boolean", help: "Confirm: this cannot be undone." } };
export const text = (value: OptionValues[string]) => typeof value === "string" ? value : undefined;
export const list = (value: OptionValues[string]) => Array.isArray(value) ? value : [];
/** `a,b` as a list; an empty value is the empty list. */
export const commaList = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);
/** `KEY=VALUE` given with a repeated option, as pairs. */
export function assignments(values: string[], error: string): Array<[string, string]> {
  return values.map(value => {
    const at = value.indexOf("=");
    if (at <= 0) return fail(error, { value });
    return [value.slice(0, at), value.slice(at + 1)];
  });
}

/** How many positional arguments a command takes, read from its `args`. */
export function arity(command: Command): { min: number; max: number } {
  const words = command.args?.split(" ").filter(Boolean) ?? [];
  return { min: words.filter(word => !word.startsWith("[") && !word.includes("...")).length, max: words.some(word => word.includes("...")) ? Infinity : words.length };
}
export function usage(command: Command): string {
  const options = Object.entries(command.options ?? {}).map(([name, option]) =>
    `[--${name}${option.type === "string" ? " " + (option.value ?? "VALUE") : ""}]${option.multiple ? "..." : ""}`);
  return ["mau", ...command.path, ...(command.args ? [command.args] : []), ...options].join(" ");
}
