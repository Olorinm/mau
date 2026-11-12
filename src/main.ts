#!/usr/bin/env node
import { loadServiceConfig } from "@agent-router/server";
import { createMau, startFailure } from "./app.js";

const optionsFile = process.env.MAU_CONFIG_FILE;
if (!optionsFile) throw new Error("MAU_CONFIG_FILE_required");
// Mau runs Router without Matrix: no homeserver or Application Service settings are read.
const mau = createMau({ ...loadServiceConfig({ ...process.env, AGENT_MATRIX: "off" }), stateDir: process.env.MAU_STATE ?? "state/mau" }, optionsFile, {},
  process.env.MAU_WEB_ROOT ? { webRoot: process.env.MAU_WEB_ROOT } : {});
const server = mau.app.listen(Number(process.env.PORT ?? "8790"), process.env.HOST ?? "127.0.0.1");
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
mau.start().then(() => { process.stdout.write(JSON.stringify({ event: "mau.started" }) + "\n"); })
  .catch(async (error: unknown) => { process.stderr.write(startFailure(error) + "\n"); await stop(); process.exitCode = 1; });
