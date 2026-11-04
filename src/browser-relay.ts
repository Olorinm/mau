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
const downloadResult = z.object({ name: z.string().max(1024), mediaType: z.string().max(200), size: z.number().int().min(0),
  contentBase64: base64, url: z.string().max(16_384).optional() }).passthrough();
const screenshotResult = z.object({ mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  contentBase64: z.string().min(1).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).passthrough();
const handoffResult = z.object({ handoffId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), liveViewUrl: z.url().max(16_384),
  expiresAt: z.iso.datetime({ offset: true }) }).passthrough();
const uploadInput = z.object({ site: z.unknown(), ref: z.unknown(), path: z.string().min(1).max(1024) }).passthrough();
export type BrowserTool = "download" | "upload" | "screenshot" | "handoff_start" | "handoff_cancel";
const relayed: BrowserTool[] = ["download", "upload", "screenshot", "handoff_start", "handoff_cancel"];

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
/** Agent-facing catalog: uploads take a workspace path; the bytes never pass through the model. */
export function agentCatalog(result: unknown, connections: string[]) {
  const parsed = z.object({ status: z.literal("completed"), tools: z.array(z.record(z.string(), z.unknown())) }).passthrough().safeParse(result);
  if (!parsed.success) return result;
  return { ...parsed.data, tools: parsed.data.tools.map(tool => {
    const found = typeof tool.name === "string" ? browserTool(tool.name, connections) : undefined;
    if (found?.tool === "upload") {
      const schema = z.record(z.string(), z.unknown()).safeParse(tool.inputSchema).data ?? {};
      const properties = { ...(z.record(z.string(), z.unknown()).safeParse(schema.properties).data ?? {}) };
      delete properties.file;
      return { ...tool, description: `${String(tool.description ?? "")} Pass path: a file path relative to your working directory (max 10 MB); Mau reads it from your workspace.`,
        inputSchema: { ...schema, properties: { ...properties, path: { type: "string", description: "File path relative to the working directory." } },
          required: [...new Set([...(Array.isArray(schema.required) ? schema.required.filter(key => key !== "file") : []), "path"])] } };
    }
    if (found?.tool === "download") return { ...tool, description: `${String(tool.description ?? "")} The file is saved under browser_downloads/ in your working directory; the result gives its path.` };
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
export async function readUpload(files: SandboxFiles, args: Record<string, unknown>) {
  const parsed = uploadInput.safeParse(args);
  if (!parsed.success || "file" in args) throw new RelayError("browser_upload_path_required");
  let relative: string;
  try { relative = validateArtifactPath(parsed.data.path); } catch { throw new RelayError("browser_upload_path_invalid"); }
  const target = await contained(files, relative);
  const [size, kind] = (await check(files, ["stat", "-c", "%s:%F", "--", target], "browser_upload_file_not_found")).trim().split(":");
  if (kind !== "regular file") throw new RelayError("browser_upload_not_a_file");
  if (!(Number(size) <= MAX_RELAY_BYTES)) throw new RelayError("browser_upload_too_large");
  const bytes = await files.readFile(target);
  if (bytes.length > MAX_RELAY_BYTES) throw new RelayError("browser_upload_too_large");
  // A swap to a symlink after the first check changes what realpath reports.
  if (await contained(files, relative) !== target) throw new RelayError("browser_upload_path_outside_workspace");
  const { path: _path, ...rest } = parsed.data, name = posix.basename(relative);
  return { ...rest, file: { name, mediaType: resolveArtifactContentType(name), contentBase64: Buffer.from(bytes).toString("base64") } };
}
const safeName = (name: string) => {
  const cleaned = posix.basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f/]/g, "_").replace(/^\.+/, "").slice(-120);
  return cleaned || "download";
};
async function saveDownload(files: SandboxFiles, result: z.infer<typeof downloadResult>) {
  const bytes = Buffer.from(result.contentBase64, "base64");
  if (bytes.length > MAX_RELAY_BYTES) throw new RelayError("browser_download_too_large");
  const folder = posix.join(files.directory, "browser_downloads");
  await check(files, ["mkdir", "-p", "--", folder], "browser_download_unwritable");
  const [root, real, ...rest] = lines(await check(files, ["realpath", "-e", "--", files.directory, folder], "browser_download_unwritable"));
  // The folder itself must not be a symlink out of the workspace.
  if (!root || rest.length || real !== posix.join(root, "browser_downloads")) throw new RelayError("browser_download_unwritable");
  const file = `${randomUUID().slice(0, 8)}-${safeName(result.name)}`;
  await files.writeFile(posix.join(real, file), bytes);
  return { path: `browser_downloads/${file}`, name: safeName(result.name), mediaType: result.mediaType, size: bytes.length };
}
export interface Handoff { connection: string; handoffId: string; liveViewUrl: string; expiresAt: string; runId: string; callId: string; status: "open" | "closed"; }
/** Translate a browser result for the model. Returns the model-facing value and, for screenshots, image items. */
export async function finishBrowser(tool: BrowserTool, outcome: unknown, files: (() => Promise<SandboxFiles>) | undefined,
  openHandoff: (handoff: Omit<Handoff, "runId" | "callId" | "status" | "connection">) => void): Promise<unknown> {
  const envelope = z.object({ status: z.literal("completed"), result: z.unknown() }).passthrough().safeParse(outcome);
  if (!envelope.success) return scrub(outcome);
  if (tool === "download") {
    const result = downloadResult.safeParse(envelope.data.result);
    if (!result.success) return { status: "failed", error: "browser_result_invalid" };
    if (!files) return { status: "failed", error: "browser_workspace_unavailable" };
    return { ...envelope.data, result: await saveDownload(await files(), result.data) };
  }
  if (tool === "screenshot") {
    const result = screenshotResult.safeParse(envelope.data.result);
    if (!result.success) return { status: "failed", error: "browser_result_invalid" };
    return { ...envelope.data, result: { mediaType: result.data.mediaType, image: "attached" },
      [IMAGE_ITEMS]: [`data:${result.data.mediaType};base64,${result.data.contentBase64}`] };
  }
  if (tool === "handoff_start") {
    const result = handoffResult.safeParse(envelope.data.result);
    if (!result.success) return { status: "failed", error: "browser_result_invalid" };
    openHandoff({ handoffId: result.data.handoffId, liveViewUrl: result.data.liveViewUrl, expiresAt: result.data.expiresAt });
    return { ...envelope.data, result: { handoffId: result.data.handoffId, expiresAt: result.data.expiresAt,
      instruction: "The owner received a private live view and can take over the browser. Wait for them, then check the page state again." } };
  }
  return scrub(outcome);
}
