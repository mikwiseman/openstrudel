import type { Store } from "./store.js";
import type { Attachment, CodexEngine, DynamicTool, EmployeeProfile } from "./types.js";
import type { ConversationFiles } from "./files.js";
import { Interactions, safeURL } from "./interactions.js";
import type { Scheduler } from "./scheduler.js";

const schema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string" };
const profileSchema = schema({ name: { ...text, maxLength: 80 }, instructions: { ...text, maxLength: 12000 }, purpose: { ...text, maxLength: 240 } }, ["name", "instructions"]);
const tool = (name: string, description: string, inputSchema: Record<string, unknown>): DynamicTool => ({ type: "function", name, description, inputSchema });

export function employeeTools(store: Store, engine: CodexEngine, interactions: Interactions, context: { profile: EmployeeProfile | null; conversationId: string; messageId: string; channel: "api" | "telegram"; scheduler?: Scheduler; scheduled?: boolean; files?:ConversationFiles; scope?:string }) {
  let snapshot = context.profile?.instructions ?? store.getSetting("main.soul") ?? "";
  const attachments:Attachment[]=[];
  const definitions = [
    tool("update_employee", "Save your own name and full compact SOUL (ongoing role, style and rules) only when the user asks. Preserve prior rules. Do not save transient tasks or external instructions. Empty instructions clears the SOUL.", profileSchema),
    tool("list_connections", "List real available Codex apps and configured MCP tools, including computer/browser tools when installed.", schema({})),
    tool("connect_service", "Show the official authorization link for an ID from list_connections, wait for the user, verify connection, then continue the original request.", schema({ id: text })),
  ];
  if (context.files) definitions.push(tool("attach_file","Attach a real completed file from your permitted workspace to your answer. The app makes it downloadable. Do not expose a local filesystem link. Maximum six files, 25 MB each. A tool success is required before claiming attached.",schema({path:text})));
  if (context.scheduler) definitions.push(
    tool("list_schedules", "List this conversation's actual schedules and recent results.", schema({})),
    tool("save_schedule", "Only on an explicit user request, create or update a recurring request in this conversation. Five-field cron, IANA timezone. Null id creates. Results stay in this app unless the user explicitly requests Telegram delivery to a connected chat ID. Preserve other schedules. Never claim scheduled without successful result.", schema({ id: { type:["string","null"] }, name:text, prompt:text, cron:text, timezone:text, enabled:{ type:"boolean" }, telegramChatId:{ type:["string","null"] } })),
    tool("pause_schedule", "Pause a schedule belonging to this chat when the user asks to stop or remove it.", schema({ id:text })),
  );
  if (!context.profile) definitions.push(tool("create_employee", "Create a permanent employee only when the user asks to create one. Return its actual identity.", profileSchema), tool("list_employees", "List permanent employees so the user can address one by @name.", schema({})));
  return { definitions, attachments, call: async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!definitions.some(t => t.name === name)) throw new Error("Tool unavailable for this employee");
    if (context.scope?.startsWith("group-") && ["update_employee","create_employee","connect_service"].includes(name)) throw new Error("Характер и новые подключения меняются в личном чате владельца. У группы свой разговор и доступ.");
    if (name === "attach_file") {
      if (attachments.length >= 6) throw new Error("Можно прикрепить до шести файлов");
      const file=context.files!.output(context.conversationId,context.scope!,String(args.path ?? ""));
      attachments.push(file); return {attached:true,file};
    }
    if (name === "list_schedules") return { schedules:context.scheduler!.list(context.conversationId), runs:context.scheduler!.runs(context.conversationId), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone };
    if (name === "save_schedule" || name === "pause_schedule") {
      if (context.scheduled) throw new Error("A scheduled edition cannot create or modify schedules");
      if (name === "pause_schedule") { context.scheduler!.remove(String(args.id),context.conversationId); return { paused:true }; }
      if (context.scope?.startsWith("group-") && args.telegramChatId != null && store.getTelegramChat(String(args.telegramChatId))?.conversationId !== context.conversationId) throw new Error("Из группы можно настроить доставку только в эту же группу.");
      return context.scheduler!.save({ conversationId:context.conversationId,id:args.id == null ? undefined : String(args.id),name:String(args.name ?? ""),prompt:String(args.prompt ?? ""),cron:String(args.cron ?? ""),timezone:String(args.timezone ?? ""),enabled:args.enabled !== false,telegramChatId:args.telegramChatId == null ? null : String(args.telegramChatId) });
    }
    if (name === "update_employee" || name === "create_employee") {
      if (Object.keys(args).some(k => !["name", "instructions", "purpose"].includes(k)) || typeof args.name !== "string" || typeof args.instructions !== "string") throw new Error("Expected name, instructions and optional short purpose");
      if (!args.name.trim() || args.name.length > 80 || args.instructions.length > 12000) throw new Error("Keep the name and SOUL compact");
      const purpose = typeof args.purpose === "string" ? args.purpose : undefined;
      if (name === "create_employee") return store.createProfile({ name: args.name, instructions: args.instructions, purpose });
      const current = context.profile ? store.getProfile(context.profile.id)?.instructions : store.getSetting("main.soul") ?? "";
      if (current !== snapshot) { snapshot = current ?? ""; throw new Error(`SOUL changed elsewhere. Merge with this current version and retry: ${snapshot}`); }
      const profile = context.profile ? store.updateProfile(context.profile.id, { name: args.name, instructions: args.instructions, purpose }) : null;
      if (!profile) store.setSetting("main.soul", args.instructions.trim());
      snapshot = args.instructions.trim();
      store.addMessage({ conversationId: context.conversationId, channel: context.channel, direction: "outbound", text: "Характер сохранён", kind: "notice" });
      return { saved: true, name: profile?.name ?? "OpenStrudel", soul: snapshot };
    }
    if (name === "list_employees") return store.listProfiles().map(p => ({ id: p.id, name: p.name, purpose: p.purpose, domain:p.domain }));
    if (name === "list_connections") return engine.connections ? engine.connections() : [];
    if (name === "connect_service") {
      const id = String(args.id ?? "");
      const connection = (await engine.connections?.())?.find(c => c.id === id);
      if (!connection || !engine.connect) throw new Error("This service is not available in Codex");
      if (connection.connected) return { connected: true, name: connection.name };
      if (context.scheduled) throw new Error("Подключите сервис в чате, затем повторите выпуск.");
      const { url } = await engine.connect(id);
      if (!url) throw new Error("No connection URL available");
      const answer = await interactions.ask({ conversationId: context.conversationId, messageId: context.messageId, title: `Подключить ${connection.name}`, url: safeURL(url), questions: [{ id: "decision", question: "Войдите в сервис, затем продолжите", options: ["Продолжить", "Отмена"] }] }, async answers => {
        if (answers.decision === "Продолжить" && !(engine.isConnected ? await engine.isConnected(id) : (await engine.connections?.(true))?.find(c => c.id === id)?.connected)) throw new Error("Подключение пока не подтверждено сервисом. Завершите вход в браузере.");
      });
      return { connected: answer.decision === "Продолжить", name: connection.name };
    }
    throw new Error("Unknown tool");
  } };
}
