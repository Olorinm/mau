import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { RouterError } from "@agent-router/server";
import type { EnvironmentProvider } from "./environments.js";
import { privateFile } from "./files.js";
import { connectSshTunnel, sshUpgrade } from "./ssh-transport.js";

export function sshKeyId(publicKey: string): string {
  const parts = publicKey.split(" "), key = Buffer.from(parts[1] ?? "", "base64");
  if (parts.length !== 2 || parts[0] !== "ssh-ed25519" || key.length !== 51 ||
      key.readUInt32BE(0) !== 11 || key.subarray(4, 15).toString() !== "ssh-ed25519" ||
      key.readUInt32BE(15) !== 32 || key.toString("base64") !== parts[1])
    throw new RouterError("invalid_ssh_public_key", 400);
  return createHash("sha256").update(publicKey).digest("hex");
}

export async function prepareSsh(provider: EnvironmentProvider, id: string, remoteDirectory: string,
  localDirectory: string, port: number, publicKey: string) {
  const keyId = sshKeyId(publicKey), directory = posix.join(remoteDirectory, "ssh");
  let token: string;
  try { token = readFileSync(join(localDirectory, "ssh-token"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    token = randomBytes(32).toString("base64url"); privateFile(join(localDirectory, "ssh-token"), token);
  }
  async function exec(argv: string[]) {
    let output = "", code: number | null = null;
    for await (const chunk of provider.exec(id, argv, { timeoutSeconds: 30, onExit: result => { code = result.exitCode; } }))
      if (chunk.stream === "stdout") output += chunk.text;
    if (code !== 0) throw new RouterError("ssh_environment_not_prepared", 502);
    return output;
  }
  await exec(["mkdir", "-p", "--", directory]);
  await exec(["chmod", "700", "--", directory]);
  await provider.writeFile(id, posix.join(directory, "token"), token);
  await exec(["chmod", "600", "--", posix.join(directory, "token")]);
  await provider.writeFile(id, posix.join(directory, "bridge.mjs"), readFileSync(new URL("./ssh-environment.mjs", import.meta.url)));
  const result = JSON.parse(await exec(["node", posix.join(directory, "bridge.mjs"), "prepare", directory, String(port), keyId, publicKey]));
  if (typeof result.username !== "string" || !/^[a-z_][a-z0-9_-]*[$]?$/.test(result.username) ||
      typeof result.hostKey !== "string") throw new RouterError("invalid_ssh_environment", 502);
  sshKeyId(result.hostKey);
  return { username: result.username as string, hostKey: result.hostKey as string, keyId };
}

export interface SshConnection { url: URL; headers: Record<string, string>; release: () => void }

/** Upgrade is authenticated separately because Express does not handle it. */
export function attachSsh(server: Server, authenticate: (token: string) => Promise<string>,
  connect: (owner: string, agentId: string, keyId: string) => Promise<SshConnection>) {
  const sockets = new Set<Duplex>();
  let closing = false;
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (sockets.size >= 128) { socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return; }
    let connection: SshConnection | undefined, upstream: Duplex | undefined, upgraded = false;
    sockets.add(socket);
    const abort = new AbortController();
    const cleanup = () => { abort.abort(); sockets.delete(socket); upstream?.destroy(); connection?.release(); };
    socket.once("close", cleanup); socket.on("error", cleanup);
    const timer = setTimeout(() => socket.destroy(), 30_000);
    try {
      const match = /^\/_mau\/v1\/agents\/([a-zA-Z0-9-]+)\/ssh\/([a-f0-9]{64})$/.exec(req.url ?? "");
      if (closing || !match || req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== sshUpgrade || req.headers.origin)
        throw new RouterError("not_found", 404);
      const owner = await authenticate(req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "");
      if (socket.destroyed) return;
      connection = await connect(owner, match[1]!, match[2]!);
      if (socket.destroyed || closing) { connection.release(); return; }
      upstream = await connectSshTunnel(connection.url, connection.headers, abort.signal);
      if (socket.destroyed || closing) { cleanup(); return; }
      upgraded = true;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${sshUpgrade}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.on("error", () => socket.destroy());
      upstream.once("close", () => socket.end());
      socket.pipe(upstream); upstream.pipe(socket);
    } catch (error) {
      cleanup();
      if (!upgraded && !socket.destroyed) socket.end(`HTTP/1.1 ${error instanceof RouterError ? error.status : 502} Request Failed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      else socket.destroy();
    } finally { clearTimeout(timer); }
  }
  const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => { void upgrade(req, socket, head); };
  server.on("upgrade", listener);
  return () => { closing = true; server.off("upgrade", listener); for (const socket of sockets) socket.destroy(); };
}
