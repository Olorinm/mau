// Runs inside the environment. When invoked as root, keeps all bridge state in root-owned /run/mau-ssh
// and authorizes only the unprivileged owner of remoteDirectory (never root).
// OpenSSH owns authentication, PTYs, command execution, forwarding and SFTP.
import fs from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const args = process.argv[1] === "prepare" || process.argv[1] === "serve" ? process.argv.slice(1) : process.argv.slice(2);
const [command, inputDirectory, portText, keyId, publicKey, bridgeBase64] = args;
const port = Number(portText);
if (!inputDirectory || !Number.isInteger(port) || port < 1024 || port > 65535 || /[\r\n"]/.test(inputDirectory))
  throw Error("invalid_ssh_configuration");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const validKeyId = value => /^[a-f0-9]{64}$/.test(value ?? "");
const digest = value => createHash("sha256").update(value).digest();

const healthProof = (token, nonce) => createHmac("sha256", token).update("mau-ssh-health:" + nonce).digest("hex");

function ensureDirectory(dir, requireRoot, mode) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) throw Error("ssh_directory_not_directory");
    if (requireRoot && st.uid !== 0) throw Error("ssh_directory_owner_invalid");
  } catch (error) {
    if (error && error.code === "ENOENT") fs.mkdirSync(dir, { mode });
    else throw error;
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (requireRoot && st.uid !== 0)) throw Error("ssh_directory_invalid");
  fs.chmodSync(dir, mode);
}

function writeAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.tmp-${randomBytes(8).toString("hex")}`;
  let fd;
  try {
    fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
    fs.writeFileSync(fd, content, "utf8");
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function readNoFollow(file, requireRoot) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (requireRoot && st.uid !== 0)) throw Error("ssh_file_invalid");
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function usernameForUid(uid) {
  if (!Number.isInteger(uid) || uid <= 0) throw Error("ssh_target_user_invalid");
  for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
    const parts = line.split(":");
    if (parts.length >= 3 && Number(parts[2]) === uid) {
      const name = parts[0];
      if (/^[a-z_][a-z0-9_-]*[$]?$/.test(name) && name !== "root") return name;
    }
  }
  throw Error("ssh_target_user_not_found");
}

if (command === "prepare") {
  if (!validKeyId(keyId) || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(publicKey ?? "")) throw Error("invalid_ssh_key");
  const token = (process.env.MAU_SSH_TOKEN ?? "").trim();
  delete process.env.MAU_SSH_TOKEN;
  if (!token || !bridgeBase64) throw Error("invalid_ssh_configuration");
  const remoteDir = resolve(inputDirectory);
  const remoteInfo = fs.lstatSync(remoteDir);
  if (!remoteInfo.isDirectory()) throw Error("ssh_remote_directory_invalid");
  let directory, username;
  if (isRoot) {
    const runInfo = fs.lstatSync("/run");
    if (!runInfo.isDirectory() || runInfo.uid !== 0) throw Error("ssh_run_directory_invalid");
    directory = "/run/mau-ssh";
    username = usernameForUid(remoteInfo.uid);
  } else {
    directory = join(remoteDir, "ssh");
    username = userInfo().username;
    if (username === "root") throw Error("ssh_target_user_invalid");
  }
  if (/[\r\n"]/.test(directory)) throw Error("invalid_ssh_configuration");
  ensureDirectory(directory, isRoot, 0o700);
  const keyDirectory = isRoot ? "/run/mau-ssh-authorized-keys" : join(directory, "keys");
  const hostKey = join(directory, "host_key");
  const configFile = join(directory, "sshd_config");
  const bridgeFile = join(directory, "bridge.mjs");
  writeAtomic(join(directory, "token"), token, 0o600);
  writeAtomic(bridgeFile, Buffer.from(bridgeBase64, "base64").toString("utf8"), 0o600);
  fs.accessSync("/usr/sbin/sshd", fs.constants.X_OK);
  ensureDirectory(keyDirectory, isRoot, isRoot ? 0o711 : 0o700);
  for (const entry of fs.readdirSync(keyDirectory)) {
    const entryPath = join(keyDirectory, entry);
    if (validKeyId(entry)) {
      const st = fs.lstatSync(entryPath);
      if (st.isSymbolicLink() || Date.now() - st.mtimeMs > 15 * 60_000) fs.rmSync(entryPath, { force: true });
    }
  }
  if (!fs.existsSync(hostKey)) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], { stdio: "pipe" });
  const expires = new Date(Date.now() + 10 * 60_000).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14) + "Z";
  writeAtomic(join(keyDirectory, keyId), `expiry-time="${expires}" ${publicKey}\n`, isRoot ? 0o644 : 0o600);
  writeAtomic(configFile, [
    `HostKey "${hostKey}"`, `PidFile "${join(directory, "sshd.pid")}"`,
    "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no",
    "PermitRootLogin no", `AllowUsers ${username}`, "StrictModes yes", "LogLevel ERROR",
    "AllowAgentForwarding no", "X11Forwarding no", "PermitTunnel no", "GatewayPorts no",
    "Subsystem sftp internal-sftp", "LoginGraceTime 30", "MaxAuthTries 3",
  ].join("\n") + "\n", 0o600);
  execFileSync("/usr/sbin/sshd", ["-t", "-f", configFile], { stdio: "pipe" });
  async function healthy() {
    try {
      const nonce = randomBytes(32).toString("hex");
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-mau-health-nonce": nonce }, redirect: "error", signal: AbortSignal.timeout(1000) });
      return response.ok && (await response.json()).proof === healthProof(token, nonce);
    } catch { return false; }
  }
  if (!await healthy()) {
    const logFd = fs.openSync(join(directory, "bridge.log"), O_WRONLY | O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW, 0o600);
    const child = spawn(process.execPath, [bridgeFile, "serve", directory, String(port)], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref(); fs.closeSync(logFd);
    let ready = false;
    for (let i = 0; i < 30; i++) { if (await healthy()) { ready = true; break; } await delay(100); }
    if (!ready) throw Error("ssh_bridge_not_ready");
  }
  console.log(JSON.stringify({ username, hostKey: readNoFollow(hostKey + ".pub", isRoot).trim().split(/\s+/).slice(0, 2).join(" ") }));
} else if (command === "serve") {
  const directory = resolve(inputDirectory);
  const dirInfo = fs.lstatSync(directory);
  if (!dirInfo.isDirectory() || (isRoot && dirInfo.uid !== 0)) throw Error("ssh_directory_invalid");
  const token = readNoFollow(join(directory, "token"), isRoot).trim();
  const expected = digest("Bearer " + token);
  const keyDirectory = isRoot ? "/run/mau-ssh-authorized-keys" : join(directory, "keys");
  const configFile = join(directory, "sshd_config");
  const authorized = value => timingSafeEqual(digest(String(value ?? "")), expected);
  let active = 0;
  const server = createServer((req, res) => {
    const nonce = req.headers["x-mau-health-nonce"];
    if (req.url !== "/health" || typeof nonce !== "string" || !/^[0-9a-f]{64}$/.test(nonce)) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ proof: healthProof(token, nonce) }));
  });
  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["x-mau-ssh-key"];
    if (req.url !== "/ssh" || req.headers.upgrade?.toLowerCase() !== "mau-ssh" ||
        !authorized(req.headers.authorization) || typeof key !== "string" || !validKeyId(key) || active >= 8) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    const path = join(keyDirectory, key);
    try {
      const st = fs.lstatSync(path);
      if (!st.isFile() || (isRoot && st.uid !== 0) || Date.now() - st.mtimeMs > 10 * 60_000) throw Error();
    } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
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
