import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import { connectSshTunnel } from "./ssh-transport.js";

interface Access { username: string; hostKey: string; keyId: string }
export async function runSsh(base: string, token: string, agentId: string,
  prepare: (publicKey: string) => Promise<Access>, command: string[], signal: AbortSignal) {
  const directory = mkdtempSync(join(tmpdir(), "mau-ssh-"));
  const identity = join(directory, "identity"), knownHosts = join(directory, "known_hosts");
  let server: ReturnType<typeof createServer> | undefined;
  const sockets = new Set<Duplex>();
  try {
    try { execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity], { stdio: "pipe", timeout: 10_000 }); }
    catch { throw new Error("openssh_client_required"); }
    const publicKey = readFileSync(identity + ".pub", "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
    const access = await prepare(publicKey);
    if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(access.username) || !/^[a-f0-9]{64}$/.test(access.keyId) ||
        !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(access.hostKey)) throw new Error("invalid_ssh_access");
    const alias = "mau-" + agentId;
    writeFileSync(knownHosts, `${alias} ${access.hostKey}\n`, { mode: 0o600 });
    const url = new URL(`/_mau/v1/agents/${encodeURIComponent(agentId)}/ssh/${access.keyId}`, base);
    let connected = false, transportError = false;
    server = createServer(socket => {
      if (connected) { socket.destroy(); return; } connected = true;
      socket.pause(); sockets.add(socket); socket.on("error", () => {});
      void connectSshTunnel(url, { Authorization: "Bearer " + token }, signal).then(upstream => {
        if (socket.destroyed) { upstream.destroy(); return; }
        sockets.add(upstream); upstream.on("error", () => socket.destroy());
        upstream.once("close", () => socket.destroy()); socket.once("close", () => upstream.destroy());
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      }).catch(() => { transportError = true; socket.destroy(); });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ssh_local_listener_failed");
    const args = ["-F", process.platform === "win32" ? "NUL" : "/dev/null", "-p", String(address.port), "-i", identity,
      "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHosts}`, "-o", `HostKeyAlias=${alias}`, "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3", "-o", "LogLevel=ERROR", `${access.username}@127.0.0.1`, ...command];
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn("ssh", args, { stdio: "inherit" });
      const abort = () => child.kill("SIGTERM"); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", () => { signal.removeEventListener("abort", abort); reject(new Error("openssh_client_required")); });
      child.once("exit", code => { signal.removeEventListener("abort", abort); resolve(code ?? 1); });
    });
    if (transportError) throw new Error("ssh_connection_failed");
    return code;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
