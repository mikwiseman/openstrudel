import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RpcMessage = { id?: number | string; result?: unknown; error?: { message?: string }; method?: string; params?: any };

/** JSONL transport only. Codex owns execution, auth, tools and history. */
export class CodexRpc {
  private readonly child;
  private readonly lines;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  closed = false;

  constructor(codexHome?: string, private readonly onNotification?: (m: RpcMessage) => void,
    private readonly onRequest?: (method: string, params: any) => Promise<unknown>,
    private readonly onClose?: (error: Error) => void, processHome?: string) {
    const executable = resolve(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")), "bin/codex.js");
    // Bot/server credentials must not become readable tool environment variables.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "TERM"]) if (process.env[key]) env[key] = process.env[key];
    if (!codexHome && process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
    if (codexHome) {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      env.CODEX_HOME = codexHome;
      // CODEX_HOME does not isolate discovery of ~/.agents or shell startup
      // files. A background Home must not enumerate the owner's Documents via
      // global skill symlinks and block on a macOS privacy prompt.
      env.HOME = processHome ?? resolve(codexHome, "user-home");
      mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
    }
    this.child = spawn(process.execPath, [executable, "app-server"], { env, stdio: "pipe" });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => { void this.receive(line); });
    this.child.stderr.resume();
    this.child.stdin.on("error", error => this.close(error));
    this.child.once("error", error => this.close(error));
    this.child.once("exit", () => this.close(new Error("Связь с Codex прервалась. Результат последнего действия нужно проверить.")));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "openstrudel", title: "OpenStrudel", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: "initialized" });
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex отключён"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex не ответил на ${method}`)); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params: params ?? {} });
    });
  }

  close(error = new Error("Codex остановлен")): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.kill();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.onClose?.(error);
  }

  private write(message: unknown): void {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private async receive(line: string): Promise<void> {
    let message: RpcMessage;
    try { message = JSON.parse(line); } catch { return; }
    // Server request IDs share the wire, not the client request namespace.
    if (message.method && message.id !== undefined) {
      try {
        if (!this.onRequest) throw new Error("Unsupported request");
        const result = await this.onRequest(message.method, message.params ?? {});
        this.write({ id: message.id, result });
      } catch (error) {
        this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    } else if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
      else pending.resolve(message.result);
    } else this.onNotification?.(message);
  }
}
