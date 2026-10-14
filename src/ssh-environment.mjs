// Runs inside the environment as its existing, unprivileged execution user.
// OpenSSH owns authentication, PTYs, command execution, forwarding and SFTP.
import fs from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const [command, inputDirectory, portText, keyId, publicKey] = process.argv.slice(2);
const directory = resolve(inputDirectory);
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || /[\r\n"]/.test(directory)) throw Error("invalid_ssh_configuration");
const token = fs.readFileSync(join(directory, "token"), "utf8").trim();
const keyDirectory = join(directory, "keys");
const hostKey = join(directory, "host_key");
const configFile = join(directory, "sshd_config");
const username = userInfo().username;
const validKeyId = value => /^[a-f0-9]{64}$/.test(value ?? "");
const authorized = value => {
  const expected = Buffer.from("Bearer " + token), actual = Buffer.from(value ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

if (command === "prepare") {
  if (!validKeyId(keyId) || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(publicKey ?? "")) throw Error("invalid_ssh_key");
  fs.accessSync("/usr/sbin/sshd", fs.constants.X_OK);
  fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(keyDirectory)) {
    if (validKeyId(entry) && Date.now() - fs.statSync(join(keyDirectory, entry)).mtimeMs > 15 * 60_000)
      fs.rmSync(join(keyDirectory, entry));
  }
  if (!fs.existsSync(hostKey)) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], { stdio: "pipe" });
  const expires = new Date(Date.now() + 10 * 60_000).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14) + "Z";
  fs.writeFileSync(join(keyDirectory, keyId), `expiry-time="${expires}" ${publicKey}\n`, { mode: 0o600 });
  fs.writeFileSync(configFile, [
    `HostKey "${hostKey}"`, `PidFile "${join(directory, "sshd.pid")}"`,
    "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no",
    "PermitRootLogin no", `AllowUsers ${username}`, "StrictModes yes", "LogLevel ERROR",
    "AllowAgentForwarding no", "X11Forwarding no", "PermitTunnel no", "GatewayPorts no",
    "Subsystem sftp internal-sftp", "LoginGraceTime 30", "MaxAuthTries 3",
  ].join("\n") + "\n", { mode: 0o600 });
  execFileSync("/usr/sbin/sshd", ["-t", "-f", configFile], { stdio: "pipe" });
  async function healthy() {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(1000) });
      return response.ok && (await response.json()).protocol === "mau-ssh-1";
    } catch { return false; }
  }
  if (!await healthy()) {
    const log = fs.openSync(join(directory, "bridge.log"), "a", 0o600);
    const child = spawn(process.execPath, [process.argv[1], "serve", directory, String(port)], { detached: true, stdio: ["ignore", log, log] });
    child.unref(); fs.closeSync(log);
    let ready = false;
    for (let i = 0; i < 30; i++) { if (await healthy()) { ready = true; break; } await delay(100); }
    if (!ready) throw Error("ssh_bridge_not_ready");
  }
  console.log(JSON.stringify({ username, hostKey: fs.readFileSync(hostKey + ".pub", "utf8").trim().split(/\s+/).slice(0, 2).join(" ") }));
} else if (command === "serve") {
  let active = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/health" || !authorized(req.headers.authorization)) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ protocol: "mau-ssh-1" }));
  });
  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["x-mau-ssh-key"];
    if (req.url !== "/ssh" || req.headers.upgrade?.toLowerCase() !== "mau-ssh" ||
        !authorized(req.headers.authorization) || typeof key !== "string" || !validKeyId(key) || active >= 8) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    const path = join(keyDirectory, key);
    try { if (Date.now() - fs.statSync(path).mtimeMs > 10 * 60_000) throw Error(); }
    catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    active++;
    const child = spawn("/usr/sbin/sshd", ["-i", "-e", "-f", configFile, "-o", `AuthorizedKeysFile="${path}"`], { stdio: ["pipe", "pipe", "ignore"] });
    const timeout = setTimeout(() => socket.destroy(), 8 * 60 * 60_000);
    let closed = false;
    const close = () => {
      if (closed) return; closed = true; active--; clearTimeout(timeout);
      child.kill(); socket.destroy(); fs.rmSync(path, { force: true });
    };
    socket.on("error", close); socket.on("close", close);
    child.on("error", close); child.on("close", () => socket.end()); child.stdin.on("error", close);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: mau-ssh\r\n\r\n");
    if (head.length) child.stdin.write(head);
    socket.pipe(child.stdin); child.stdout.pipe(socket);
  });
  server.headersTimeout = 10_000;
  server.listen(port, "0.0.0.0");
} else throw Error("invalid_ssh_command");
