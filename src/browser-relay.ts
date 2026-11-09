import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { resolveArtifactContentType, validateArtifactPath } from "@olorinm/agent-environment/workspace";
import { browserToolName } from "./connected-apps.js";

/** The Agent's own sandbox, as seen by Mau. Never handed to the model; paths are checked inside the sandbox. */
export interface SandboxFiles {
  /** The runtime's working directory; uploads and downloads stay below it. */
  directory: string;
  exec(argv: string[]): Promise<{ exitCode: number | null; stdout: string }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}
export const MAX_RELAY_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 8_000_000;
/** Tool results carry images to the native Host as separate content items, never as text. */
export const IMAGE_ITEMS = "mau:images";
export class RelayError extends Error {}
const base64 = z.string().max(Math.ceil(MAX_RELAY_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const fileResult = z.object({ name: z.string().max(1024), mediaType: z.string().max(200), size: z.number().int().min(0), contentBase64: base64 }).passthrough();
const commandResult = z.object({ files: z.array(fileResult).max(10).optional() }).passthrough();
const handoffResult = z.object({ handoffId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), liveViewUrl: z.url().max(16_384),
  expiresAt: z.iso.datetime({ offset: true }), instructions: z.string().max(500).optional() }).passthrough();
/** What the model passes to the browser tools: agent-browser arguments and, from the shell command, its directory. */
const commandInput = z.object({ args: z.array(z.string()).min(1).max(100), cwd: z.string().max(4096).optional() }).strict();
export type BrowserTool = "agent_browser_read" | "agent_browser_write" | "handoff_start" | "handoff_cancel";
const relayed: BrowserTool[] = ["agent_browser_read", "agent_browser_write", "handoff_start", "handoff_cancel"];

export function browserTool(name: string, connections: string[]): { connection: string; tool: BrowserTool } | undefined {
  for (const connection of connections)
    for (const tool of relayed) if (name === browserToolName(connection, tool)) return { connection, tool };
  return undefined;
}
/** Any live-view address is for the owner only; strip it from everything the model can read. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "liveViewUrl").map(([key, item]) => [key, scrub(item)]));
  return value;
}
const FILES_NOTE = " screenshot, pdf and download files are saved under browser_downloads/ in your working directory; the result gives their paths.";
/** Agent-facing catalog: uploads take workspace paths; file bytes never pass through the model. */
export function agentCatalog(result: unknown, connections: string[]) {
  const parsed = z.object({ status: z.literal("completed"), tools: z.array(z.record(z.string(), z.unknown())) }).passthrough().safeParse(result);
  if (!parsed.success) return result;
  return { ...parsed.data, tools: parsed.data.tools.map(tool => {
    const found = typeof tool.name === "string" ? browserTool(tool.name, connections) : undefined;
    if (found?.tool === "agent_browser_write") return { ...tool,
      description: "Send workspace files to the current site with agent-browser's upload command, e.g. args [\"upload\",\"@e3\",\"cv.pdf\"]. " +
        "File paths are relative to your working directory (max 10 MB in total); Mau reads them from your workspace and the owner approves the files and site.",
      inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100,
        description: "agent-browser arguments: upload <file input> <path...>" } }, required: ["args"], additionalProperties: false } };
    if (found?.tool === "agent_browser_read") return { ...tool, description: `${String(tool.description ?? "")}${FILES_NOTE}` };
    if (found?.tool === "handoff_start") return { ...tool, description: `${String(tool.description ?? "")} The owner receives the live view privately; you receive only the handoff ID and expiry.` };
    return tool;
  }) };
}
const lines = (text: string) => text.split("\n").filter(Boolean);
async function check(files: SandboxFiles, argv: string[], error: string) {
  const result = await files.exec(argv);
  if (result.exitCode !== 0) throw new RelayError(error);
  return result.stdout;
}
/** Resolve symlinks inside the sandbox and require the target to stay below the working directory. */
async function contained(files: SandboxFiles, relative: string) {
  const [root, target, ...rest] = lines(await check(files, ["realpath", "-e", "--", files.directory, posix.join(files.directory, relative)], "browser_upload_file_not_found"));
  if (!root || !target || rest.length || !target.startsWith(root === "/" ? "/" : root + "/")) throw new RelayError("browser_upload_path_outside_workspace");
  return target;
}
/** A workspace path, relative to the shell's directory when the command gave one, as a path below the working directory. */
function workspacePath(files: SandboxFiles, path: string, cwd: string | undefined) {
  let relative = path;
  if (cwd !== undefined || posix.isAbsolute(path)) {
    if (cwd !== undefined && !posix.isAbsolute(cwd)) throw new RelayError("browser_upload_path_invalid");
    relative = posix.relative(files.directory, posix.resolve(cwd ?? files.directory, path));
    if (!relative || relative.startsWith("../") || relative === ".." || posix.isAbsolute(relative)) throw new RelayError("browser_upload_path_outside_workspace");
  }
  try { return validateArtifactPath(relative); } catch { throw new RelayError("browser_upload_path_invalid"); }
}
async function readFile(files: SandboxFiles, relative: string) {
  const target = await contained(files, relative);
  const [size, kind] = (await check(files, ["stat", "-c", "%s:%F", "--", target], "browser_upload_file_not_found")).trim().split(":");
  if (kind !== "regular file") throw new RelayError("browser_upload_not_a_file");
  if (!(Number(size) <= MAX_RELAY_BYTES)) throw new RelayError("browser_upload_too_large");
  const bytes = await files.readFile(target);
  if (bytes.length > MAX_RELAY_BYTES) throw new RelayError("browser_upload_too_large");
  // A swap to a symlink after the first check changes what realpath reports.
  if (await contained(files, relative) !== target) throw new RelayError("browser_upload_path_outside_workspace");
  return bytes;
}
/**
 * Turns the model's browser arguments into the connector's input. For `upload` Mau reads each named workspace file,
 * passes it by name with its bytes, and adds the current page's origin (read from the browser) as the approved site.
 */
export async function prepareBrowser(tool: BrowserTool, args: Record<string, unknown>, files: (() => Promise<SandboxFiles>) | undefined,
  currentUrl: () => Promise<string | undefined>): Promise<Record<string, unknown>> {
  if (tool !== "agent_browser_read" && tool !== "agent_browser_write") return args;
  const parsed = commandInput.safeParse(args);
  if (!parsed.success) {
    if (tool === "agent_browser_write") throw new RelayError("browser_upload_path_required");
    return args;
  }
  if (tool === "agent_browser_read") return { args: parsed.data.args };
  if (!files) throw new RelayError("browser_workspace_unavailable");
  const sandbox = await files();
  // upload <selector> <path...>; the only flag agent-browser accepts here is --json.
  const positions = parsed.data.args.flatMap((arg, index) => arg.startsWith("-") ? [] : [index]);
  if (parsed.data.args[positions[0]!] !== "upload" || positions.length < 3) throw new RelayError("browser_upload_path_required");
  const rewritten = [...parsed.data.args], uploads: Array<{ name: string; mediaType: string; contentBase64: string }> = [];
  let total = 0;
  for (const index of positions.slice(2)) {
    const relative = workspacePath(sandbox, rewritten[index]!, parsed.data.cwd);
    const bytes = await readFile(sandbox, relative), name = posix.basename(relative);
    total += bytes.length;
    if (total > MAX_RELAY_BYTES) throw new RelayError("browser_upload_too_large");
    if (uploads.some(file => file.name === name)) throw new RelayError("browser_upload_duplicate_name");
    // Browser file inputs take a bare MIME type; drop parameters such as "; charset=utf-8".
    uploads.push({ name, mediaType: resolveArtifactContentType(name).split(";")[0]!.trim().toLowerCase(), contentBase64: Buffer.from(bytes).toString("base64") });
    rewritten[index] = name;
  }
  let site: string | undefined;
  try { site = new URL((await currentUrl()) ?? "").origin; } catch { site = undefined; }
  if (!site || site === "null") throw new RelayError("browser_current_page_unavailable");
  return { args: rewritten, site, files: uploads };
}
const safeName = (name: string) => {
  const cleaned = posix.basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f/]/g, "_").replace(/^\.+/, "").slice(-120);
  return cleaned || "download";
};
async function saveFile(files: SandboxFiles, result: z.infer<typeof fileResult>) {
  const bytes = Buffer.from(result.contentBase64, "base64");
  if (bytes.length > MAX_RELAY_BYTES) throw new RelayError("browser_download_too_large");
  const folder = posix.join(files.directory, "browser_downloads");
  await check(files, ["mkdir", "-p", "--", folder], "browser_download_unwritable");
  const [root, real, ...rest] = lines(await check(files, ["realpath", "-e", "--", files.directory, folder], "browser_download_unwritable"));
  // The folder itself must not be a symlink out of the workspace.
  if (!root || rest.length || real !== posix.join(root, "browser_downloads")) throw new RelayError("browser_download_unwritable");
  const file = `${randomUUID().slice(0, 8)}-${safeName(result.name)}`;
  await files.writeFile(posix.join(real, file), bytes);
  return { path: posix.join(real, file), name: safeName(result.name), mediaType: result.mediaType, size: bytes.length };
}
export interface Handoff { connection: string; handoffId: string; liveViewUrl: string; expiresAt: string; instructions?: string; runId: string; callId: string; status: "open" | "closed"; }
/** Translate a browser result for the model. Returns the model-facing value and, for screenshots, image items. */
export async function finishBrowser(tool: BrowserTool, outcome: unknown, files: (() => Promise<SandboxFiles>) | undefined,
  openHandoff: (handoff: Omit<Handoff, "runId" | "callId" | "status" | "connection">) => void): Promise<unknown> {
  const envelope = z.object({ status: z.literal("completed"), result: z.unknown() }).passthrough().safeParse(outcome);
  if (!envelope.success) return scrub(outcome);
  if (tool === "agent_browser_read") {
    const result = commandResult.safeParse(envelope.data.result);
    if (!result.success) return { status: "failed", error: "browser_result_invalid" };
    if (!result.data.files?.length) return scrub(outcome);
    if (!files) return { status: "failed", error: "browser_workspace_unavailable" };
    const sandbox = await files(), saved = [], images: string[] = [];
    for (const file of result.data.files) {
      saved.push(await saveFile(sandbox, file));
      if (["image/png", "image/jpeg", "image/webp"].includes(file.mediaType) && file.contentBase64.length <= MAX_IMAGE_BASE64)
        images.push(`data:${file.mediaType};base64,${file.contentBase64}`);
    }
    return { ...envelope.data, result: { ...result.data, files: saved }, ...(images.length ? { [IMAGE_ITEMS]: images } : {}) };
  }
  if (tool === "handoff_start") {
    const result = handoffResult.safeParse(envelope.data.result);
    if (!result.success) return { status: "failed", error: "browser_result_invalid" };
    openHandoff({ handoffId: result.data.handoffId, liveViewUrl: result.data.liveViewUrl, expiresAt: result.data.expiresAt,
      ...(result.data.instructions ? { instructions: result.data.instructions } : {}) });
    return { ...envelope.data, result: { handoffId: result.data.handoffId, expiresAt: result.data.expiresAt,
      instruction: "The owner received a private live view and can take over the browser. Wait for them, then check the page state again." } };
  }
  return scrub(outcome);
}
