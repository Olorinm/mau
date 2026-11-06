import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { RouterError } from "@agent-router/server";
import type { FeishuApplication } from "./connector-accounts.js";

/** Router's saved Feishu bot application (`credentials.json` beside its `app-secret`), the same format connectors use. */
const credentialsSchema = z.object({ version: z.literal(1), appId: z.string().regex(/^cli_[a-zA-Z0-9_]{1,128}$/),
  appSecretFile: z.string().min(1).max(200), domain: z.enum(["feishu", "lark"]), ownerOpenId: z.string().regex(/^ou_[a-zA-Z0-9_-]{1,128}$/) }).strict();

interface ChannelConnection { kind: string; credentialsFile?: string | undefined }

/**
 * The app that the Agent's Feishu chat channel already uses. One Feishu app serves both directions: Router keeps its bot
 * identity for chat, and the same app is handed to Agent Connectors for the owner's user authorization (no second QR).
 */
export function chatChannelApplication(connections: ChannelConnection[] | undefined, agentDirectory: string): FeishuApplication {
  const channel = connections?.find(c => c.kind === "feishu");
  if (!channel) throw new RouterError("feishu_chat_not_connected", 409);
  // Channels configured with an inline appId/appSecretFile pair have no owner binding to hand over.
  if (!channel.credentialsFile) throw new RouterError("feishu_chat_owner_binding_required", 409);
  const file = resolve(agentDirectory, channel.credentialsFile);
  let credentials: z.infer<typeof credentialsSchema>, appSecret: string;
  try {
    credentials = credentialsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (isAbsolute(credentials.appSecretFile) || credentials.appSecretFile.split(/[\\/]/).includes("..")) throw new Error("path");
    appSecret = readFileSync(resolve(dirname(file), credentials.appSecretFile), "utf8").trim();
  } catch { throw new RouterError("feishu_chat_credentials_unavailable", 409); }
  if (!appSecret) throw new RouterError("feishu_chat_credentials_unavailable", 409);
  return { appId: credentials.appId, appSecret, domain: credentials.domain, ownerOpenId: credentials.ownerOpenId };
}
