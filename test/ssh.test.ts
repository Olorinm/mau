import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouterError } from "@agent-router/server";
import { attachSsh, sshKeyId } from "../src/ssh.js";
import { connectSshTunnel } from "../src/ssh-transport.js";

it("SSH tunnels preserve binary streams and release access when either end disconnects", async () => {
  const upstream = createServer();
  const upstreamSockets = new Set<any>();
  upstream.on("upgrade", (req, socket, head) => {
    expect(req.headers.authorization).toBe("Bearer environment-secret");
    upstreamSockets.add(socket); socket.on("error", () => {});
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: mau-ssh\r\n\r\n");
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const gateway = createServer(); let releases = 0, accesses = 0;
  const close = attachSsh(gateway, async req => {
    if (req.headers.authorization !== "Bearer owner") throw new RouterError("account_session_invalid", 401);
    return "alice";
  }, async (owner, agent, key) => {
    expect(owner).toBe("alice"); expect(agent).toBe("agent"); expect(key).toBe("a".repeat(64)); accesses++;
    let released = false;
    return { url: new URL(`http://127.0.0.1:${(upstream.address() as any).port}/ssh`),
      headers: { Authorization: "Bearer environment-secret" }, release: () => { if (!released) { released = true; releases++; } } };
  });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const url = new URL(`http://127.0.0.1:${(gateway.address() as any).port}/_mau/v1/agents/agent/ssh/${"a".repeat(64)}`);
  try {
    await expect(connectSshTunnel(url, { Authorization: "Bearer wrong" })).rejects.toThrow("account_session_invalid");
    expect(accesses).toBe(0);
    const client = await connectSshTunnel(url, { Authorization: "Bearer owner" });
    const sent = randomBytes(2 * 1024 * 1024), chunks: Buffer[] = []; let length = 0;
    const complete = new Promise<void>(resolve => client.on("data", chunk => {
      chunks.push(chunk); length += chunk.length; if (length === sent.length) resolve();
    }));
    client.write(sent); await complete;
    expect(Buffer.concat(chunks).equals(sent)).toBe(true);
    client.destroy(); await expect.poll(() => releases).toBe(1);
    const again = await connectSshTunnel(url, { Authorization: "Bearer owner" });
    again.resume();
    const ended = once(again, "close"); close(); await ended;
    expect(releases).toBe(2);
  } finally {
    close(); for (const socket of upstreamSockets) socket.destroy();
    await Promise.all([new Promise<void>(r => upstream.close(() => r())), new Promise<void>(r => gateway.close(() => r()))]);
  }
}, 15_000);

it("ssh-environment refuses symlinked remote or ssh directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "mau-ssh-sec-"));
  try {
    const script = readFileSync(new URL("../src/ssh-environment.mjs", import.meta.url), "utf8");
    const key = "ssh-ed25519 " + Buffer.concat([Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIA==", "base64"), Buffer.alloc(32, 9)]).toString("base64");
    const keyId = sshKeyId(key), victim = join(dir, "victim"), link = join(dir, "remote-link");
    mkdirSync(victim); symlinkSync(victim, link);
    const run = (target: string) => spawnSync(process.execPath,
      ["--input-type=module", "-e", script, "--", "prepare", target, "37421", keyId, key, Buffer.from(script, "utf8").toString("base64")],
      { encoding: "utf8", env: { ...process.env, MAU_SSH_TOKEN: "test-token-123456789012345678901234" } });
    expect(run(link).status).not.toBe(0);
    const realRemote = join(dir, "remote"); mkdirSync(realRemote);
    symlinkSync(victim, join(realRemote, "ssh"));
    expect(run(realRemote).status).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
