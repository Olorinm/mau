#!/usr/bin/env node
import { loadServiceConfig } from "@agent-router/server";
import { createMau, startFailure } from "./app.js";
import { localLogin } from "./local-login.js";

const optionsFile = process.env.MAU_CONFIG_FILE;
if (!optionsFile) throw new Error("MAU_CONFIG_FILE_required");
const config = loadServiceConfig(), host = process.env.HOST ?? "127.0.0.1";
// Local mode replaces the edge identity with one owner token, on a loopback address only.
const authenticate = process.env.MAU_LOCAL_TOKEN_FILE ? localLogin(process.env.MAU_LOCAL_TOKEN_FILE, host, config, optionsFile) : undefined;
const mau = createMau({ ...config, stateDir: process.env.MAU_STATE ?? "state/mau" }, optionsFile, authenticate ? { router: { authenticate } } : {},
  process.env.MAU_WEB_ROOT ? { webRoot: process.env.MAU_WEB_ROOT } : {});
const server = mau.app.listen(Number(process.env.PORT ?? "8790"), host);
mau.attach(server);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close(); server.closeAllConnections();
  await mau.close();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
// A port that is taken, or any other listen failure, ends the process instead of leaving it without a server.
server.once("error", async error => { process.stderr.write(startFailure(error) + "\n"); await stop(); process.exitCode = 1; });
mau.start().then(() => { process.stdout.write(JSON.stringify({ event: "mau.started" }) + "\n"); })
  .catch(async (error: unknown) => { process.stderr.write(startFailure(error) + "\n"); await stop(); process.exitCode = 1; });
