// A scripted stand-in for the pinned `grok` CLI: `login --device-auth`, `logout` and `agent stdio` (ACP).
// MOCK_GROK_SCENARIO names a JSON script; every launch and ACP message is appended to MOCK_GROK_LOG.
// It never contacts a vendor.
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const scenario = JSON.parse(readFileSync(process.env.MOCK_GROK_SCENARIO, "utf8"));
const log = entry => appendFileSync(process.env.MOCK_GROK_LOG, JSON.stringify(entry) + "\n");
const args = process.argv.slice(2), home = process.env.GROK_HOME;
log({ start: { args, cwd: process.cwd(), env: process.env } });

if (args.includes("login")) {
  // The device-code text of Grok Build 1.0.52 (xai-grok-login), on stderr with its gray hint.
  process.stderr.write(`To sign in, open this URL in your browser:\n  https://accounts.x.ai/device?user_code=ABCD-1234\n  (Could not open browser automatically — open the URL above manually.)\n`
    + `Then enter this code: ABCD-1234\n\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m\nWaiting for authorization...\n`);
  const done = setInterval(() => {
    if (existsSync(join(home, "approve"))) { writeFileSync(join(home, "auth.json"), "{}"); process.stdout.write(" Signed in as owner@example.invalid\n"); process.exit(0); }
    if (existsSync(join(home, "deny"))) { process.stderr.write("Error: access_denied\n"); process.exit(1); }
  }, 20);
  process.on("SIGTERM", () => { clearInterval(done); log({ killed: "login" }); process.exit(143); });
} else if (args.includes("logout")) {
  rmSync(join(home, "auth.json"), { force: true });
  process.stdout.write("Logged out\n");
} else {
  const fail = error => new acp.RequestError(error.code, error.message, error.data);
  let servers = [], cancelled;
  const cancel = new Promise(resolve => { cancelled = resolve; });
  const say = (client, sessionId, text) => client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  const mcp = async (method, params) => {
    const server = servers.find(s => s.name === "openstrudel");
    const response = await fetch(server.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map(h => [h.name, h.value])) } });
    return (await response.json()).result;
  };
  const options = [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Once", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }];
  // Grok Build reports a turn's usage in the session/prompt response's _meta.
  const usage = () => scenario.usage ? { _meta: { usage: scenario.usage } } : {};
  const step = async (client, sessionId, s) => {
    if (s.text !== undefined) await say(client, sessionId, s.text);
    if (s.thought !== undefined) await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: s.thought } } });
    if (s.tool) await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", status: "pending", ...s.tool } });
    if (s.permission) {
      const result = await client.request("session/request_permission", { sessionId, options, ...s.permission });
      log({ answered: "session/request_permission", result });
      // Grok Build's own tool then writes the file it was allowed to.
      if (s.write && result.outcome.optionId === "once") writeFileSync(s.write, "scratch");
      // Grok Build 1.0.52 ends the whole turn when a permission is rejected (cancellation_category permission_rejected).
      if (scenario.cancelOnReject && result.outcome.optionId === "no") return { stopReason: "cancelled", ...usage() };
    }
    if (s.ask) log({ answered: "x.ai/ask_user_question", result: await client.request("x.ai/ask_user_question", { sessionId, ...s.ask }) });
    if (s.mcp) {
      await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "1" } });
      await say(client, sessionId, JSON.stringify(await mcp("tools/call", s.mcp)));
    }
    if (s.stderr) process.stderr.write(s.stderr);
    if (s.exit !== undefined) process.exit(s.exit);
    if (s.waitCancel) { await cancel; return { stopReason: "cancelled", ...usage() }; }
    if (s.hang) { process.on("SIGTERM", () => {}); await new Promise(() => {}); }
  };
  acp.agent({ name: "mock-grok" })
    .onRequest("initialize", ({ params }) => {
      log({ method: "initialize", params });
      return { protocolVersion: acp.PROTOCOL_VERSION, authMethods: [{ id: "cached_token", name: "Cached token" }, { id: "xai.api_key", name: "API key" }],
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true } } };
    })
    .onRequest("authenticate", ({ params }) => { log({ method: "authenticate", params }); if (scenario.authenticate) throw fail(scenario.authenticate); return {}; })
    .onRequest("session/new", ({ params }) => {
      log({ method: "session/new", params });
      servers = params.mcpServers;
      return { sessionId: "s-new", configOptions: scenario.configOptions };
    })
    .onRequest("session/load", async ({ params, client }) => {
      log({ method: "session/load", params });
      if (scenario.load) throw fail(scenario.load);
      servers = params.mcpServers;
      // Loading replays the saved conversation before it answers.
      await say(client, params.sessionId, "an earlier reply");
      return { configOptions: scenario.configOptions };
    })
    .onRequest("session/set_config_option", ({ params }) => {
      log({ method: "session/set_config_option", params });
      return { configOptions: scenario.configOptions.map(o => o.id === params.configId ? { ...o, currentValue: params.value } : o) };
    })
    .onRequest("session/prompt", async ({ params, client }) => {
      log({ method: "session/prompt", params });
      for (const s of scenario.turn ?? [{ text: "ok" }]) {
        const stop = await step(client, params.sessionId, s);
        if (stop) return stop;
      }
      if (scenario.prompt) throw fail(scenario.prompt);
      return { stopReason: "end_turn", ...usage() };
    })
    // An ACP extension method travels with a leading underscore, as the pinned Grok Build answers it.
    .onRequest("_x.ai/billing", params => params, async ({ params }) => {
      log({ method: "_x.ai/billing", params });
      if (scenario.billingError) throw fail(scenario.billingError);
      return scenario.billing ?? {};
    })
    .onNotification("session/cancel", ({ params }) => { log({ method: "session/cancel", params }); cancelled(); })
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
}
