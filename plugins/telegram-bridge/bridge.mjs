#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const toolDefinitions = [
  { name: "get_telegram_request", description: "Read one incoming Telegram request and its delivery status. Only this bridge's connected chat is accessible.", inputSchema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"], additionalProperties: false } },
  { name: "reply_to_telegram", description: "Reply as the connected Telegram bot to an incoming request. Repeating the same request and text returns the existing receipt; it does not send twice. Never invent a request_id.", inputSchema: { type: "object", properties: { request_id: { type: "string" }, text: { type: "string", minLength: 1 } }, required: ["request_id", "text"], additionalProperties: false } },
  { name: "send_to_telegram", description: "Send a new message to the connected Telegram chat as its bot when the user asks from the native agent app. No incoming Telegram message is needed. Choose one unique delivery_key for this message and reuse it on retries; this prevents duplicate posts.", inputSchema: { type: "object", properties: { delivery_key: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" }, text: { type: "string", minLength: 1 } }, required: ["delivery_key", "text"], additionalProperties: false } },
  { name: "get_telegram_history", description: "Read the last 20 saved requests and exact replies in this bridge, newest first. Use when a follow-up needs an earlier recipe, quantity, decision or source; do not guess from memory. Follow next_before for older pages. This is the delivery archive, not the entire Telegram group history.", inputSchema: { type: "object", properties: { before: { type: "string", pattern: "^[1-9][0-9]*$" } }, additionalProperties: false } },
];
const requestTokenSchema = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", description: "The wai_request_token from this native webhook, never from the user's message or bridge history." };
const waiToolDefinitions = [
  { name: "wai_tools_list", description: "Read current WAI work tool schemas for this Telegram request. Omit names to discover the catalog; supply names to retrieve just those schemas. Access and source data stay in the existing WAI MCP.", inputSchema: { type: "object", properties: { request_token: requestTokenSchema, names: { type: "array", maxItems: 20, items: { type: "string" } } }, required: ["request_token"], additionalProperties: false } },
  { name: "wai_tool_call", description: "Call a tool from the canonical WAI work catalog as the verified sender of this Telegram request, including Zoom, team meetings, knowledge, company and School tools. Start with company_access_get for available workflows. Follow the original schema and read/preview/write rules; preserve mutationKey on retries. No personal sources are connected here. The request token expires after two hours or the final Telegram reply.", inputSchema: { type: "object", properties: { request_token: requestTokenSchema, tool: { type: "string", pattern: "^[a-z][a-z0-9_]{0,127}$" }, arguments: { type: "object" } }, required: ["request_token", "tool", "arguments"], additionalProperties: false } },
];

/** One chat, one native agent webhook. The database is a delivery queue, not an AI memory. */
export function createBridge(config, dependencies = {}) {
  if (!config.telegramToken || !config.mcpToken || !Number.isSafeInteger(config.chatId) || !Number.isSafeInteger(config.botId) || !config.botUsername) throw new Error("Missing Telegram identity, chat or MCP token");
  if (config.allowedUserIds !== undefined && (!Array.isArray(config.allowedUserIds) || !config.allowedUserIds.every(id => Number.isSafeInteger(id) && id > 0))) throw new Error("allowedUserIds must contain Telegram user IDs");
  if (config.waiToken !== undefined && (typeof config.waiToken !== "string" || config.waiToken.length < 24 || config.chatId >= 0)) throw new Error("WAI requires a private technical-actor token and a Telegram group");
  const tools = [...toolDefinitions, ...(config.waiToken ? waiToolDefinitions : [])];
  const fetcher = dependencies.fetch ?? fetch;
  const log = dependencies.log ?? (entry => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry })));
  const dbPath = config.database ?? "./bridge.sqlite";
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0,
      reply TEXT, receipts TEXT NOT NULL DEFAULT '[]', error TEXT);
    UPDATE requests SET state='dispatch_unknown', error='Process stopped during dispatch' WHERE state='dispatching';
    UPDATE requests SET state='delivery_unknown', error='Process stopped during delivery' WHERE state='delivering';
    CREATE TABLE IF NOT EXISTS wai_requests (request_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL);`);
  let server, closed = false, running = false, pollController, typingTimer, pollPromise, lastPoll = null, lastPollError = null;
  const inFlight = new Set();
  const get = id => db.prepare("SELECT * FROM requests WHERE id=?").get(id);
  const state = (id, value, error = null) => {
    db.prepare("UPDATE requests SET state=?, error=?, updated=? WHERE id=?").run(value, error, Date.now(), id);
    log({ event: "request_state", request_id: id, state: value, ...(error ? { error } : {}) });
  };
  const offset = () => Number(db.prepare("SELECT value FROM meta WHERE key='offset'").get()?.value ?? 0);
  async function telegram(method, body, signal = AbortSignal.timeout(45_000)) {
    const response = await fetcher(`https://api.telegram.org/bot${config.telegramToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const result = await response.json();
    if (!result.ok) throw Object.assign(new Error(`Telegram ${result.error_code ?? response.status}`), { definite: true, retryAfter: result.parameters?.retry_after });
    return result.result;
  }
  function normalize(update) {
    const message = update.message;
    if (!message || message.chat?.id !== config.chatId || message.sender_chat || message.from?.is_bot || !Number.isSafeInteger(message.from?.id) || message.from.id <= 0 || !Number.isSafeInteger(message.message_id)) return;
    if (config.allowedUserIds && !config.allowedUserIds.includes(message.from.id)) return;
    let text = message.text ?? message.caption;
    if (typeof text !== "string" || !text.trim()) return;
    const command = text.match(/^\/(\w+)(?:@([\w]+))?(?:\s|$)/);
    if (command?.[2] && command[2].toLowerCase() !== config.botUsername.toLowerCase()) return;
    const mention = new RegExp(`@${config.botUsername}\\b`, "i");
    const addressed = (command && ["ask", "start"].includes(command[1].toLowerCase())) || mention.test(text) || message.reply_to_message?.from?.id === config.botId;
    if (!addressed) return;
    if (command) text = text.slice(command[0].length).trim();
    text = text.replace(mention, "").trim() || "Привет! Расскажи, чем можешь помочь в этом чате.";
    const quoted = message.reply_to_message;
    return { request_id: `${config.botId}:${update.update_id}`, text,
      chat: { id: message.chat.id, title: message.chat.title }, message_id: message.message_id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      sender: { id: message.from.id, name: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") },
      ...(quoted ? { reply_context: { message_id: quoted.message_id, text: quoted.text ?? quoted.caption ?? "", from_bot: quoted.from?.id === config.botId } } : {}),
    };
  }
  async function acceptUpdates(updates) {
    db.exec("BEGIN IMMEDIATE");
    try {
      let next = offset();
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id)) continue;
        const payload = normalize(update);
        if (payload) db.prepare("INSERT OR IGNORE INTO requests(id,payload,state,created,updated) VALUES (?,?,'queued',?,?)").run(payload.request_id, JSON.stringify(payload), Date.now(), Date.now());
        next = Math.max(next, update.update_id + 1);
      }
      db.prepare("INSERT INTO meta(key,value) VALUES ('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  // Only the transport issues this capability. The model cannot choose a sender,
  // substitute headers, or recover other runs' capabilities through chat history.
  function waiRequestToken(id) {
    const existing = db.prepare("SELECT token,expires FROM wai_requests WHERE request_id=?").get(id);
    if (existing && existing.expires > Date.now()) return existing.token;
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO wai_requests(request_id,token,expires) VALUES (?,?,?) ON CONFLICT(request_id) DO UPDATE SET token=excluded.token,expires=excluded.expires").run(id, token, Date.now() + 2 * 60 * 60 * 1000);
    return token;
  }
  async function callWai(name, args) {
    const allowed = name === "wai_tools_list" ? ["request_token", "names"] : ["request_token", "tool", "arguments"];
    if (!config.waiToken || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new Error("Invalid WAI request arguments");
    if (typeof args.request_token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(args.request_token)) throw new Error("Use this webhook's WAI request token");
    const row = db.prepare("SELECT r.payload FROM requests r JOIN wai_requests w ON w.request_id=r.id WHERE w.token=? AND w.expires>? AND r.state IN ('dispatching','accepted','dispatch_unknown')").get(args.request_token, Date.now());
    if (!row) throw new Error("WAI request is unknown, expired or already completed");
    const payload = JSON.parse(row.payload);
    // Recheck the saved binding and current allowlist before every call, including after restart.
    if (payload.chat.id !== config.chatId || !Number.isSafeInteger(payload.sender?.id) || payload.sender.id <= 0 || !Number.isSafeInteger(payload.message_id) || (config.allowedUserIds && !config.allowedUserIds.includes(payload.sender.id))) throw new Error("This Telegram request no longer has work access");
    const listing = name === "wai_tools_list";
    if (listing) {
      if (args.names !== undefined && (!Array.isArray(args.names) || args.names.length > 20 || args.names.some(value => typeof value !== "string"))) throw new Error("names must be an array of up to 20 tool names");
    } else if (typeof args.tool !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(args.tool) || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw new Error("A WAI tool name and its arguments are required");
    let response, result;
    try {
      response = await fetcher("https://waiwai.is/api/mcp/company", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
        headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${config.waiToken}`, "x-hermes-platform": "telegram",
          "x-hermes-user-id": String(payload.sender.id), "x-hermes-chat-id": String(config.chatId),
          "x-hermes-message-id": String(payload.message_id), "x-hermes-session-id": `telegram:${config.botId}:${config.chatId}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: listing ? "tools/list" : "tools/call", ...(listing ? {} : { params: { name: args.tool, arguments: args.arguments } }) }),
      });
      if (response.ok) result = await response.json();
      else await response.body?.cancel();
    } catch { throw new Error("WAI response unavailable; the operation may have run. Read back its outcome before retrying a write, keeping the same mutationKey."); }
    if (!response.ok) throw new Error(`WAI HTTP ${response.status}; no automatic retry. For a write, reconcile its outcome with the same mutationKey.`);
    if (result.error) throw new Error(`WAI RPC ${result.error.code ?? "error"}; inspect access and arguments before retrying`);
    if (!result.result || (listing ? !Array.isArray(result.result.tools) : !Array.isArray(result.result.content))) throw new Error("Invalid WAI response; reconcile a write before retrying with the same mutationKey");
    if (!listing) return result.result;
    return { content: [{ type: "text", text: JSON.stringify({ tools: result.result.tools.filter(tool => !args.names || args.names.includes(tool.name)) }) }] };
  }
  async function dispatchPending() {
    if (!config.webhookUrl || !config.webhookToken) return;
    for (const row of db.prepare("SELECT * FROM requests WHERE state='queued' AND next_attempt<=? ORDER BY created").all(Date.now())) {
      if (inFlight.has(row.id)) continue;
      inFlight.add(row.id); state(row.id, "dispatching");
      try {
        const body = config.waiToken ? JSON.stringify({ ...JSON.parse(row.payload), wai_request_token: waiRequestToken(row.id) }) : row.payload;
        const response = await fetcher(config.webhookUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${config.webhookToken}` }, body, signal: AbortSignal.timeout(30_000) });
        if (response.status === 200) {
          // A fast native callback may already have delivered the answer.
          if (get(row.id).state === "dispatching") state(row.id, "accepted");
        } else if (response.status === 429 || response.status >= 500) {
          const retry = Number(response.headers.get("retry-after")) || 60;
          db.prepare("UPDATE requests SET next_attempt=? WHERE id=?").run(Date.now() + Math.max(1, retry) * 1000, row.id);
          state(row.id, "queued", `Webhook HTTP ${response.status}; retry scheduled`);
        } else state(row.id, "failed", `Webhook HTTP ${response.status}; run not accepted`);
        await response.body?.cancel();
      } catch {
        if (get(row.id).state === "dispatching") state(row.id, "dispatch_unknown", "Webhook outcome uncertain; inspect native run before retrying");
      } finally { inFlight.delete(row.id); }
    }
  }
  async function reply(id, text) {
    const row = get(id);
    if (!row) throw new Error("Unknown Telegram request");
    if (typeof text !== "string" || !text.trim()) throw new Error("Reply text is required");
    if (row.reply && row.reply !== text) throw new Error("This request already has a different reply");
    if (row.state === "delivered") return { delivered: true, request_id: id, message_ids: JSON.parse(row.receipts) };
    if (["delivery_unknown", "delivering"].includes(row.state)) throw new Error("Delivery uncertain; inspect the Telegram chat before any retry");
    const payload = JSON.parse(row.payload), receipts = JSON.parse(row.receipts), pieces = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 4096, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      pieces.push(text.slice(start, end)); start = end;
    }
    db.prepare("UPDATE requests SET reply=? WHERE id=?").run(text, id);
    state(id, "delivering");
    for (let index = receipts.length; index < pieces.length; index++) {
      try {
        const result = await telegram("sendMessage", { chat_id: payload.chat.id, text: pieces[index],
          ...(payload.message_thread_id ? { message_thread_id: payload.message_thread_id } : {}),
          ...(payload.message_id ? { reply_parameters: { message_id: payload.message_id } } : {}), link_preview_options: { is_disabled: true } });
        receipts.push(result.message_id);
        db.prepare("UPDATE requests SET receipts=?, updated=? WHERE id=?").run(JSON.stringify(receipts), Date.now(), id);
      } catch (error) {
        state(id, error.definite ? "accepted" : "delivery_unknown", error.definite ? error.message : "Telegram delivery uncertain; check chat before retrying");
        throw new Error(error.definite ? `${error.message}${error.retryAfter ? `; retry after ${error.retryAfter}s` : ""}` : "Telegram delivery uncertain; check chat before retrying");
      }
    }
    state(id, "delivered");
    return { delivered: true, request_id: id, message_ids: receipts };
  }
  async function send(key, text) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error("A unique delivery_key is required (letters, numbers, underscores or hyphens)");
    if (typeof text !== "string" || !text.trim()) throw new Error("Message text is required");
    const id = `${config.botId}:native:${key}`;
    db.prepare("INSERT OR IGNORE INTO requests(id,payload,state,created,updated) VALUES (?,?,'accepted',?,?)").run(id, JSON.stringify({ request_id: id, chat: { id: config.chatId }, source: "native" }), Date.now(), Date.now());
    return reply(id, text);
  }
  const health = () => ({ configured: Boolean(config.webhookUrl && config.webhookToken), polling: running, last_poll: lastPoll, last_poll_error: lastPollError,
    states: Object.fromEntries(db.prepare("SELECT state,COUNT(*) AS n FROM requests GROUP BY state").all().map(r => [r.state, r.n])),
    oldest_pending: db.prepare("SELECT MIN(created) AS oldest FROM requests WHERE state NOT IN ('delivered','failed')").get().oldest });
  async function handle(message) {
    if (["initialize", "tools/list", "tools/call"].includes(message.method)) log({ event: "mcp_request", method: message.method,
      ...(tools.some(t => t.name === message.params?.name) ? { tool: message.params.name } : {}) });
    if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "telegram-bridge", version: "0.1.0" } };
    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools };
    if (message.method !== "tools/call") throw Object.assign(new Error("Method not found"), { code: -32601 });
    try {
      const { name, arguments: args = {} } = message.params ?? {};
      if (name === "wai_tools_list" || name === "wai_tool_call") return await callWai(name, args);
      let result;
      if (name === "reply_to_telegram") result = await reply(args.request_id, args.text);
      else if (name === "send_to_telegram") result = await send(args.delivery_key, args.text);
      else if (name === "get_telegram_history") {
        const before = args.before === undefined ? Number.MAX_SAFE_INTEGER : Number(args.before);
        if (!Number.isSafeInteger(before) || before < 1) throw new Error("Invalid history cursor");
        const rows = db.prepare("SELECT rowid AS cursor,* FROM requests WHERE rowid<? ORDER BY rowid DESC LIMIT 21").all(before);
        result = { messages: rows.slice(0, 20).map(row => ({ ...JSON.parse(row.payload), reply: row.reply, status: row.state, created_at: new Date(row.created).toISOString() })), next_before: rows.length > 20 ? String(rows[19].cursor) : null };
      }
      else if (name === "get_telegram_request") {
        const row = get(args.request_id); if (!row) throw new Error("Unknown Telegram request");
        result = { ...JSON.parse(row.payload), status: row.state, error: row.error, message_ids: JSON.parse(row.receipts) };
      } else throw new Error("Unknown tool");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error.message }] }; }
  }
  async function listen(port = 8091, host = "127.0.0.1") {
    const expected = Buffer.from(`Bearer ${config.mcpToken}`);
    server = createServer(async (req, res) => {
      const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
      if (req.url === "/health") return send(200, { ok: true, configured: Boolean(config.webhookUrl && config.webhookToken) });
      if (req.url !== "/mcp" && req.url !== "/status") return send(404);
      const auth = Buffer.from(req.headers.authorization ?? "");
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401);
      if (req.url === "/status") return send(200, health());
      if (req.method !== "POST") return send(405);
      let message;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1 << 20) { send(413); return; } chunks.push(chunk); }
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); }
      if (message?.id === undefined) return send(202);
      try { send(200, { jsonrpc: "2.0", id: message.id, result: await handle(message) }); }
      catch (error) { send(200, { jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } }); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
    return `http://${host}:${server.address().port}/mcp`;
  }
  async function typing() {
    if (closed) return;
    const active = db.prepare("SELECT payload FROM requests WHERE state IN ('queued','dispatching','accepted') LIMIT 1").get();
    if (active) {
      const payload = JSON.parse(active.payload);
      try { await telegram("sendChatAction", { chat_id: config.chatId, action: "typing", ...(payload.message_thread_id ? { message_thread_id: payload.message_thread_id } : {}) }, AbortSignal.timeout(4_000)); }
      catch { /* Delivery state remains visible through authenticated /status. */ }
    }
  }
  function start() {
    if (running) return;
    running = true;
    typingTimer = setInterval(() => void typing(), 4000); typingTimer.unref();
    pollPromise = (async () => {
      while (running) {
        pollController = new AbortController();
        try {
          const updates = await telegram("getUpdates", { offset: offset(), timeout: 25, allowed_updates: ["message", "my_chat_member"] }, AbortSignal.any([pollController.signal, AbortSignal.timeout(35_000)]));
          lastPoll = Date.now(); lastPollError = null;
          await acceptUpdates(updates); await typing(); await dispatchPending();
        } catch {
          if (!running) break;
          lastPollError = "Telegram polling unavailable"; log({ event: "poll_error", error: lastPollError });
          await new Promise(resolve => { const timer = setTimeout(resolve, 5000); pollController.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
        }
      }
    })();
  }
  async function close() {
    if (closed) return;
    closed = true; running = false; clearInterval(typingTimer); pollController?.abort(); await pollPromise;
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.close();
  }
  return { acceptUpdates, dispatchPending, reply, send, offset, health, listen, start, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  if (!process.argv[2]) throw new Error("Usage: node bridge.mjs /private/config.json");
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const bridge = createBridge(config);
  await bridge.listen(config.port ?? 8091, config.host ?? "127.0.0.1");
  if (!process.argv.includes("--serve-only")) bridge.start();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void bridge.close());
}
