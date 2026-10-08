import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { endpoint, HomeError, type Endpoint } from "./home.js";
import { homeRequest, requestJSON, resultJSON } from "./home-transport.js";
import { listClientAttempts, recordClientAttempt } from "./client-attempt.js";
import { readExtensionBundle } from "./extension-bundle.js";
import { isApprovalMode } from "./approval-mode.js";

type Connection = Endpoint & { token: string; homeId?: string; epoch?: number };
const path = () => process.env.OPENSTRUDEL_CLIENT_CONFIG ?? resolve(homedir(), ".config/openstrudel/connection.json");
export async function readClientConnection(): Promise<Connection> {
  for (const filename of [path(), resolve(".data/LocalConnection.json"), resolve(homedir(), "Library/Application Support/OpenStrudel/LocalConnection.json")]) {
    try { const value = JSON.parse(await readFile(filename, "utf8")); return { ...endpoint(value), token: String(value.token ?? ""), homeId: value.homeId, epoch: value.epoch }; }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  throw new HomeError("Сначала запустите Home или выполните openstrudel connect с приглашением через stdin.");
}
async function saveConnection(value: Connection) {
  const filename = path(); await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  // Save destination and token together; never print the credential.
  const { rename } = await import("node:fs/promises");
  const tmp = filename + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(tmp, filename);
}
export async function readInput(): Promise<string> {
  if (process.stdin.isTTY) throw new HomeError("Передайте JSON или приглашение через stdin. Пароли и ключи не нужны в аргументах команды.");
  let value = "";
  for await (const chunk of process.stdin) { value += chunk; if (Buffer.byteLength(value) > 300 * 1024 * 1024) throw new HomeError("Входной файл слишком большой."); }
  return value.trim();
}
export async function clientCommand(command: string, args: string[]): Promise<boolean> {
  const json = args.includes("--json"), deviceIndex = args.indexOf("--device"), deviceId = deviceIndex < 0 ? undefined : args[deviceIndex + 1];
  if (deviceIndex >= 0 && (!deviceId || deviceId.startsWith("--"))) throw new HomeError("Укажите идентификатор после --device.");
  const attemptIndex = args.indexOf("--request-id"), requestedId = attemptIndex < 0 ? undefined : args[attemptIndex + 1];
  if (attemptIndex >= 0 && (!requestedId || requestedId.startsWith("--"))) throw new HomeError("Укажите UUID после --request-id.");
  const clean = args.filter((a, i) => a !== "--json" && (deviceIndex < 0 || i !== deviceIndex && i !== deviceIndex + 1) && (attemptIndex < 0 || i !== attemptIndex && i !== attemptIndex + 1));
  if (requestedId && command !== "message" && !(command === "agents" && ["create", "move"].includes(clean[0] ?? ""))) throw new HomeError("--request-id доступен для message, agents create и agents move.");
  const output = (value: unknown) => console.log(typeof value === "string" && !json ? value : JSON.stringify(value, null, 2));
  if (command === "help" || command === "--help") {
    output("OpenStrudel\n\nstart · doctor · connect · web · servers help\ndevices list | invite | join\nhome status | backup --output FILE | restore | transfer DEVICE\nhome operation ID | retry ID | request ID | cancel ID | attempts\nagents list | create | accounts AGENT | move AGENT DEVICE\nagents export --output FILE | preview FILE | import FILE\naccounts list | add NAME | login ID | status ID LOGIN_ID | use ID | logout ID\ntelegram status | pair | group AGENT\napprovals status | set ask|auto|approve_all [--yes]\nservices list | add NAME | connect ID | remove NAME\nskills / plugins list | preview PATH | install PATH | enable ID | disable ID | remove ID\n--agent ID или --chat ID выбирает, кому доступны сервисы и навыки.\nmessage [--agent ID] ТЕКСТ\n\n--device ID выбирает устройство для аккаунтов, создания и копии агентов.\nНастройки и секреты передаются через stdin в JSON. --json включает JSON для скриптов.\nДля message, agents create и agents move сохраняется request-id. После обрыва повторите ту же команду с --request-id UUID; список: home attempts.\nИмпорт добавляет копии. move сохраняет идентичность агента и одну работающую копию.\nРезервная копия управления и экспорт агентов — разные файлы."); return true;
  }
  if (command === "connect") {
    const raw = await readInput();
    let connection: Connection;
    if (raw.startsWith("openstrudel://")) {
      const url = new URL(raw), q = url.searchParams;
      if (url.host !== "connect" || !q.get("keyPin") || !q.get("key")) throw new HomeError("Создайте новое приглашение в обновлённом OpenStrudel.");
      const target = endpoint({ url: `https://${q.get("host")}:${q.get("port")}`, pin: q.get("keyPin") });
      const { createHash } = await import("node:crypto");
      const attemptPath = path() + ".pair-attempt";
      const keyHash = createHash("sha256").update(q.get("key")!).digest("hex");
      let attempt: { keyHash: string; id: string } | undefined;
      try { attempt = JSON.parse(await readFile(attemptPath, "utf8")); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      if (attempt?.keyHash !== keyHash) { attempt = { keyHash, id: randomUUID() }; await mkdir(dirname(attemptPath), { recursive: true, mode: 0o700 }); await writeFile(attemptPath, JSON.stringify(attempt), { mode: 0o600 }); }
      const result = resultJSON(await homeRequest(target, "/pair", q.get("key")!, { method: "POST" }, 20_000, { "x-openstrudel-pair-id": attempt!.id }));
      connection = { ...target, token: result.token };
    } else {
      const input = JSON.parse(raw); connection = { ...endpoint(input), token: String(input.token ?? "") };
      if (!connection.token) throw new HomeError("В подключении нет ключа доступа.");
      resultJSON(await homeRequest(connection, "/health", connection.token));
    }
    const health = resultJSON(await homeRequest(connection, "/health", connection.token));
    connection.homeId = health.homeId;
    await saveConnection(connection); output({ connected: true, url: connection.url }); return true;
  }
  if (!["devices", "home", "agents", "accounts", "web", "message", "telegram", "services", "skills", "plugins", "approvals"].includes(command)) return false;
  let connection = await readClientConnection();
  const attempt = async (operation: string, payload: unknown, id = requestedId) => {
    const requestId = await recordClientAttempt(path() + ".attempts", { requestId: id, operation, payload, deviceId, home: connection.homeId ?? connection.url + "#" + (connection.pin ?? "") });
    console.error("request-id: " + requestId + ". После обрыва повторите ту же команду с --request-id " + requestId + ".");
    return requestId;
  };
  const call = async (route: string, method = "GET", value?: unknown, binary = false, requestId?: string): Promise<any> => {
    if (deviceId && !route.startsWith("/v1/home") && !route.startsWith("/v1/devices")) route += (route.includes("?") ? "&" : "?") + "deviceId=" + encodeURIComponent(deviceId);
    let result = await homeRequest(connection, route, connection.token, { method, ...(value === undefined ? {} : { body: Buffer.isBuffer(value) ? value.toString("base64") : requestJSON(value), contentType: Buffer.isBuffer(value) ? "application/octet-stream" : "application/json" }) }, 60_000, method === "GET" ? {} : { "idempotency-key": requestId ?? randomUUID() });
    if (result.status === 409 && method === "GET") {
      const moved = JSON.parse(Buffer.from(result.body, "base64").toString()).moved;
      if (moved) {
        const replacement = { ...endpoint(moved), token: connection.token };
        if (!replacement.pin || !replacement.url.startsWith("https:") || !moved.homeId || !Number.isSafeInteger(moved.epoch) || connection.homeId && moved.homeId !== connection.homeId || connection.epoch && moved.epoch <= connection.epoch) throw new HomeError("Не удалось подтвердить новое главное. Используйте новое приглашение.");
        const identity = resultJSON(await homeRequest(replacement, "/v1/home/identity", ""));
        if (identity.protocol !== 1 || identity.nodeId !== moved.primaryId || identity.homeId !== moved.homeId || identity.role !== "primary" || identity.epoch !== moved.epoch) throw new HomeError("Передача ещё не подтверждена новым главным устройством.");
        result = await homeRequest(replacement, route, replacement.token);
        if (result.status >= 400) resultJSON(result); connection = { ...replacement, homeId: moved.homeId, epoch: moved.epoch }; await saveConnection(connection);
      }
    }
    if (result.status === 202 && method !== "GET" && route.split("?")[0] !== "/v1/messages") {
      const queued = resultJSON(result);
      if (queued.operationId) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const receipt = resultJSON(await homeRequest(connection, "/v1/home/requests/" + encodeURIComponent(queued.operationId), connection.token));
          if (receipt.response) { result = receipt.response; break; }
          if (receipt.status === "canceled") throw new HomeError("Операция отменена до передачи устройству.", 409);
        }
        if (result.status === 202) throw new HomeError(`Операция сохранена, завершение ещё не подтверждено. Не повторяйте её: openstrudel home request ${queued.operationId}`, 202);
      }
    }
    if (binary && result.status >= 200 && result.status < 300) return Buffer.from(result.body, "base64");
    return resultJSON(result);
  };
  const [action = "list", id, extra] = clean;
  const readJSON = async () => JSON.parse(await readInput());
  if (["services","skills","plugins"].includes(command)) {
    const option = (key:string) => { const n=clean.indexOf(key); if(n<0)return; if(!clean[n+1] || clean[n+1]!.startsWith("--"))throw new HomeError("Укажите значение после "+key); return clean[n+1]; };
    const conversationId = option("--chat") ?? (await call("/v1/agents/"+encodeURIComponent(option("--agent") ?? "main")+"/conversation")).conversation.id;
    const query="?conversationId="+encodeURIComponent(conversationId);
    if(action === "list") {
      const value=await call((command === "services" ? "/v1/connections" : "/v1/extensions")+query);
      output(command === "services" ? value : {...value,items:value.items.filter((item:{kind:string})=>item.kind === (command === "skills" ? "skill" : "plugin"))});
    }
    else if(command === "services" && action === "add" && id) output(await call("/v1/extensions/mcp","POST",{...await readJSON(),name:id,conversationId}));
    else if(command === "services" && action === "remove" && id) output(await call("/v1/extensions/mcp/remove","POST",{name:id.replace(/^mcp:/,""),conversationId}));
    else if(command === "services" && action === "connect" && id) output(await call("/v1/connections/connect","POST",{id,conversationId}));
    else if(command !== "services" && ["preview","install"].includes(action) && id) {
      const files=await readExtensionBundle(id),preview=await call("/v1/extensions/preview","POST",{files,conversationId});
      if(preview.kind!==(command === "skills" ? "skill" : "plugin"))throw new HomeError("Тип пакета не совпадает с командой. Используйте skills для навыка или plugins для плагина.");
      output(action === "preview" ? preview : await call("/v1/extensions/install","POST",{files,digest:preview.digest,conversationId}));
    } else if(command !== "services" && ["enable","disable","remove"].includes(action) && id) output(await call("/v1/extensions/change","POST",{id,conversationId,...(action === "remove" ? {} : {enabled:action === "enable"})}));
    else throw new HomeError("Сервисы: list, add NAME (JSON через stdin), connect ID, remove NAME. Навыки и плагины: list, preview PATH, install PATH, enable ID, disable ID, remove ID. --agent выбирает сотрудника; --chat — его группу.");
  } else if (command === "devices") {
    if (action === "list") output(await call("/v1/devices"));
    else if (action === "invite") output(await call("/v1/devices/invitation", "POST", {}));
    else if (action === "join") output(await call("/v1/home/join", "POST", { invitation: await readJSON() }));
    else throw new HomeError("Используйте devices list, invite или join.");
  } else if (command === "home") {
    if (action === "status" || action === "list") output(await call("/v1/home"));
    else if (action === "attempts") output({ attempts: await listClientAttempts(path() + ".attempts"), note: "Сохранённые идентификаторы команд. Это не подтверждение их выполнения." });
    else if (action === "backup") {
      const filename = clean[clean.indexOf("--output") + 1];
      if (!clean.includes("--output") || !filename) throw new HomeError("Укажите --output для зашифрованной копии.");
      const result = await call("/v1/home/backup", "POST", await readJSON());
      await writeFile(resolve(filename), result.archive, { mode: 0o600, flag: "wx" }); output({ saved: resolve(filename), includesAgentFiles: false });
    } else if (action === "restore") output(await call("/v1/home/restore", "POST", await readJSON()));
    else if (action === "transfer" && id) {
      const input = await readJSON();
      if (typeof input.backupFile !== "string" || !input.backupFile) throw new HomeError("Укажите backupFile и backupPassword в JSON.");
      const backup = await call("/v1/home/backup", "POST", { password: input.backupPassword });
      await writeFile(resolve(input.backupFile), backup.archive, { mode: 0o600, flag: "wx" });
      const result = await call("/v1/home/transfer", "POST", { deviceId: id, operationId: input.operationId ?? randomUUID(), backupPassword: input.backupPassword });
      // The handover's final snapshot supersedes the preflight copy atomically.
      if (result.backup) {
        const { rename } = await import("node:fs/promises");
        const temp = resolve(input.backupFile) + "." + randomUUID();
        await writeFile(temp, result.backup, { mode: 0o600, flag: "wx" }); await rename(temp, resolve(input.backupFile));
      }
      delete result.backup; output({ ...result, backupFile: resolve(input.backupFile) });
    } else if (action === "operation" && id) output(await call("/v1/home/operations/" + encodeURIComponent(id)));
    else if (action === "retry" && id) output(await call("/v1/home/operations/" + encodeURIComponent(id) + "/retry", "POST", {}));
    else if (action === "request" && id) output(await call("/v1/home/requests/" + encodeURIComponent(id)));
    else if (action === "cancel" && id) output(await call("/v1/home/requests/" + encodeURIComponent(id), "DELETE"));
    else throw new HomeError("Используйте home status, backup, restore, transfer, operation, request или cancel.");
  } else if (command === "approvals") {
    if (action === "status" || action === "list") output(await call("/v1/settings/approvals"));
    else if (action === "set" && isApprovalMode(id)) {
      if (id === "approve_all" && !clean.includes("--yes")) throw new HomeError("Без подтверждений сотрудники смогут изменять данные доступных сервисов. Для этого режима добавьте --yes.");
      output(await call("/v1/settings/approvals","POST",{mode:id,confirm:clean.includes("--yes")}));
    } else throw new HomeError("Используйте approvals status или approvals set ask|auto|approve_all. --device выбирает устройство.");
  } else if (command === "telegram") {
    if (action === "status" || action === "list") output((await call("/v1/integrations")).telegram);
    else if (action === "pair") output(await call("/v1/integrations/telegram/link", "POST", {}));
    else if (action === "group" && id) {
      const link = await call("/v1/integrations/telegram/link", "POST", { kind: "group", profileId: id });
      const url = link.url ? new URL(link.url) : null;
      if (url?.origin !== "https://t.me" || url.searchParams.get("startgroup") !== link.code) throw new HomeError("Обновите OpenStrudel на устройстве этого сотрудника, чтобы подключить группу.");
      output(link);
    }
    else throw new HomeError("Используйте telegram status, pair или group ID_СОТРУДНИКА. --device выбирает устройство.");
  } else if (command === "accounts") {
    if (action === "list") output(await call("/v1/accounts"));
    else if (action === "add") output(await call("/v1/accounts", "POST", { name: clean.slice(1).join(" ") }));
    else if (id && action === "login") output(await call(`/v1/accounts/${encodeURIComponent(id)}/login`, "POST", {}));
    else if (id && extra && action === "status") output(await call(`/v1/accounts/${encodeURIComponent(id)}/login/${encodeURIComponent(extra)}`));
    else if (id && ["use", "logout"].includes(action)) output(await call(`/v1/accounts/${encodeURIComponent(id)}/${action === "use" ? "priority" : "logout"}`, "POST", {}));
    else throw new HomeError("Неизвестная команда accounts. Откройте openstrudel help.");
  } else if (command === "agents") {
    if (action === "list") output(await call("/v1/profiles"));
    else if (action === "create") {
      const input = await readJSON(), { creationId, ...payload } = input;
      if (requestedId && creationId && requestedId !== creationId) throw new HomeError("creationId и --request-id должны совпадать.");
      const requestId = await attempt("agents create", payload, requestedId ?? creationId);
      output(await call("/v1/profiles", "POST", { ...payload, creationId: requestId }, false, requestId));
    }
    else if (action === "accounts" && id) output(await call(`/v1/agents/${encodeURIComponent(id)}/accounts`, "POST", await readJSON()));
    else if (action === "move" && id && extra) {
      const requestId = await attempt("agents move", { agentId: id, deviceId: extra });
      output(await call(`/v1/agents/${encodeURIComponent(id)}/move`, "POST", { deviceId: extra, operationId: requestId }, false, requestId));
    }
    else if (action === "export") {
      const filename = clean[clean.indexOf("--output") + 1];
      if (!clean.includes("--output") || !filename) throw new HomeError("Укажите --output FILE для копии агентов выбранного устройства.");
      const bytes = await call("/v1/agents/archive", "GET", undefined, true);
      await writeFile(resolve(filename), bytes, { mode: 0o600, flag: "wx" }); output({ saved: resolve(filename) });
    } else if (["preview", "import"].includes(action) && id) {
      const bytes = await readFile(resolve(id));
      if (bytes.length > 192 * 1024 * 1024) throw new HomeError("Копия превышает 192 МБ.");
      const preview = await call("/v1/agents/archive/preview", "POST", bytes);
      output(action === "preview" ? preview : await call("/v1/agents/archive/import?plan=" + encodeURIComponent(preview.planToken), "POST", bytes));
    }
    else throw new HomeError("Откройте openstrudel help: доступны агенты, перенос, экспорт и импорт.");
  } else if (command === "web") output(await call("/v1/web/invitation", "POST", { owner: true, local: connection.url.startsWith("http:") }));
  else {
    const index = clean.indexOf("--agent"), profile = index >= 0 ? clean[index + 1] : undefined;
    if (index >= 0 && (!profile || profile.startsWith("--"))) throw new HomeError("Укажите идентификатор после --agent.");
    const text = clean.filter((_, n) => index < 0 || n !== index && n !== index + 1).join(" ");
    if (!text.trim()) throw new HomeError("Напишите сообщение после команды message.");
    const payload = { text, profile, externalChatId: "home" }, requestId = await attempt("message", payload);
    const result = await call("/v1/messages", "POST", { ...payload, externalId: requestId }, false, requestId);
    output(!json && result.text ? result.text : result);
  }
  return true;
}
