import type { CodexEngine } from "./types.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type TelegramMcpServers = Record<string, { url: string; http_headers?: Record<string,string>; approvedTools?: string[]; allowedSenders?: string[] }>;
type Actor = NonNullable<Parameters<CodexEngine["run"]>[1]>["telegramActor"];

/** Older Homes ignore the separate file containing tool-limited transport credentials. */
export function readTelegramMcpServers(root: string, context: string): TelegramMcpServers | undefined {
  const prefix = resolve(root, ".data/connections", context);
  const read = (path: string): TelegramMcpServers | undefined => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  const ordinary = read(prefix + ".telegram.json");
  const approved = read(prefix + ".approved-telegram.json");
  if (!approved) return ordinary;
  if (Object.values(approved).some(s => !Array.isArray(s.approvedTools) || !s.approvedTools.length)) throw new Error("Missing approved Telegram tools");
  return {...ordinary, ...approved};
}

/** Installer-provisioned services use the verified sender, never a model argument
 * or a shared owner's identity. Without a channel identity they stay disabled. */
export function telegramMcpConfig(servers: TelegramMcpServers | undefined, actor: Actor, conversationId?: string, access?: boolean): Record<string,unknown> {
  const config:Record<string,unknown> = {};
  for (const [name,server] of Object.entries(servers ?? {})) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid Telegram service name");
    const url = new URL(server.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Telegram services require an HTTPS endpoint");
    const valid = actor && /^[1-9]\d{0,19}$/.test(actor.userId) && /^-?[1-9]\d{0,19}$/.test(actor.chatId) && /^[\d:-]+$/.test(actor.messageId);
    const tools = server.approvedTools;
    if (tools !== undefined && (!Array.isArray(tools) || !tools.length || tools.length > 100 || tools.some(tool => typeof tool !== "string" || !/^[\w.-]{1,128}$/.test(tool)))) throw new Error("Invalid approved Telegram tools");
    const senders = server.allowedSenders;
    if (tools !== undefined && (!Array.isArray(senders) || !senders.length || senders.some(id => typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)))) throw new Error("Missing approved Telegram senders");
    const admitted = Boolean(valid && (tools === undefined || (access === true && senders?.includes(actor.userId))));
    const headers = Object.fromEntries(Object.entries(server.http_headers ?? {}).filter(([key])=>!key.toLowerCase().startsWith("x-hermes-")));
    config[`mcp_servers.${name}`] = {
      url:server.url, enabled:admitted, ...(tools ? {enabled_tools:tools} : {}),
      http_headers:{...(tools && !admitted ? {} : headers),...(admitted && actor ? {
        "x-hermes-platform":"telegram", "x-hermes-user-id":actor.userId,
        "x-hermes-chat-id":actor.chatId, "x-hermes-message-id":actor.messageId,
        "x-hermes-session-id":"openstrudel:"+(conversationId ?? actor.chatId),
      } : {})},
    };
  }
  return config;
}
