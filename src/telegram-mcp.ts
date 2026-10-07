import type { CodexEngine } from "./types.js";

export type TelegramMcpServers = Record<string, { url: string; http_headers?: Record<string,string> }>;
type Actor = NonNullable<Parameters<CodexEngine["run"]>[1]>["telegramActor"];

/** Installer-provisioned services use the verified sender, never a model argument
 * or a shared owner's identity. Without a channel identity they stay disabled. */
export function telegramMcpConfig(servers: TelegramMcpServers | undefined, actor: Actor, conversationId?: string): Record<string,unknown> {
  const config:Record<string,unknown> = {};
  for (const [name,server] of Object.entries(servers ?? {})) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid Telegram service name");
    const url = new URL(server.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Telegram services require an HTTPS endpoint");
    const valid = actor && /^[1-9]\d{0,19}$/.test(actor.userId) && /^-?[1-9]\d{0,19}$/.test(actor.chatId) && /^[\d:-]+$/.test(actor.messageId);
    const headers = Object.fromEntries(Object.entries(server.http_headers ?? {}).filter(([key])=>!key.toLowerCase().startsWith("x-hermes-")));
    config[`mcp_servers.${name}`] = {
      url:server.url, enabled:Boolean(valid),
      http_headers:{...headers,...(valid ? {
        "x-hermes-platform":"telegram", "x-hermes-user-id":actor.userId,
        "x-hermes-chat-id":actor.chatId, "x-hermes-message-id":actor.messageId,
        "x-hermes-session-id":"openstrudel:"+(conversationId ?? actor.chatId),
      } : {})},
    };
  }
  return config;
}
