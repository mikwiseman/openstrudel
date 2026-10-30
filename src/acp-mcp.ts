import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { hostEnvironment } from "./claude.js";
import type { CodexEngine } from "./types.js";

type Tools = NonNullable<NonNullable<Parameters<CodexEngine["run"]>[1]>["tools"]>;

/** The employee tools as a loopback MCP server (Streamable HTTP, JSON replies) for one turn.
 * Its random path and bearer token die with it, so a CLI that stores its session cannot call them later. */
export async function toolBridge(tools: Tools): Promise<Bridge> {
  const handle = async ({ method, params }: any) => {
    if (method === "initialize") return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openstrudel", version: "1" } };
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: tools.definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    if (method === "tools/call") {
      if (!tools.definitions.some(d => d.name === params?.name)) return { content: [{ type: "text", text: `Unknown tool ${params?.name}` }], isError: true };
      try { return { content: [{ type: "text", text: JSON.stringify(await tools.call(params.name, params.arguments ?? {})) }] }; }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  };
  return serve(async message => {
    try { return { jsonrpc: "2.0", id: message.id, result: await handle(message) }; }
    catch (error: any) { return { jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } }; }
  });
}

/** A stdio MCP service of the employee, run by OpenStrudel as the Claude CLI runs them, behind the same kind of endpoint. Grok starts
 * stdio services inside its own sandbox, which reads only the workspace, so a service whose script or keys live elsewhere could not start;
 * those keys stay out of the sandbox. Messages pass through unchanged; the service stops with the turn. */
export async function stdioBridge(service: { command: string; args?: string[]; env?: Record<string, string> }, cwd: string): Promise<Bridge> {
  const child = spawn(service.command, service.args ?? [], { cwd, env: { ...hostEnvironment(), ...service.env }, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<unknown, (reply: object) => void>();
  let gone: string | undefined;
  const fail = (reason: string) => { gone ??= reason; for (const [id, answer] of pending) answer({ jsonrpc: "2.0", id, error: { code: -32603, message: gone } }); pending.clear(); };
  child.on("error", error => fail(`${service.command}: ${error.message}`));
  child.on("exit", () => fail(`${service.command} stopped`));
  child.stdin.on("error", () => {});
  const write = (message: object) => { if (!gone) child.stdin.write(JSON.stringify(message) + "\n"); };
  createInterface({ input: child.stdout }).on("line", line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    // The service's own requests (roots, sampling) are not offered.
    if (message?.method !== undefined) { if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported" } }); return; }
    pending.get(message?.id)?.(message); pending.delete(message?.id);
  });
  const bridge = await serve(message => {
    if (gone) return Promise.resolve({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: gone } });
    return new Promise(answer => { pending.set(message.id, answer); write(message); });
  }, message => write(message));
  return { ...bridge, close: async () => { child.kill(); await bridge.close(); } };
}

type Bridge = { url: string; token: string; close(): Promise<void> };

/** One turn's loopback endpoint (Streamable HTTP, JSON replies): a random path and a bearer token. */
async function serve(respond: (request: any) => Promise<object>, notify: (message: any) => void = () => {}): Promise<Bridge> {
  const path = "/" + randomBytes(16).toString("hex"), token = randomBytes(32).toString("hex");
  const expected = Buffer.from("Bearer " + token);
  const reply = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (req.url !== path) return reply(res, 404);
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(res, 401);
    if (req.method !== "POST") return reply(res, 405);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4 << 20) req.destroy(); else chunks.push(chunk); });
    req.on("end", async () => {
      let message: any;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      // Notifications and responses need no answer.
      if (message?.id === undefined) { notify(message); return reply(res, 202); }
      reply(res, 200, await respond(message));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, token,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
