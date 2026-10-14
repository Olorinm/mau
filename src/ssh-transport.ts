import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

export const sshUpgrade = "mau-ssh";

/** HTTP Upgrade carries an unmodified, end-to-end OpenSSH byte stream. */
export function connectSshTunnel(url: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "GET", headers: { ...headers, Connection: "Upgrade", Upgrade: sshUpgrade },
      ...(signal ? { signal } : {}),
    });
    const timer = setTimeout(() => request.destroy(new Error("ssh_connection_timeout")), 20_000);
    request.once("upgrade", (response, socket, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== sshUpgrade) {
        socket.destroy(); reject(new Error("ssh_connection_rejected")); return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.once("response", response => {
      clearTimeout(timer); response.resume();
      reject(new Error(response.statusCode === 401 ? "account_session_invalid" : "ssh_connection_rejected"));
    });
    request.once("error", error => { clearTimeout(timer); reject(error); });
    request.end();
  });
}
