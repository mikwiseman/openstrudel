#!/usr/bin/env node
import { OpenStrudelRuntime } from "./runtime.js";
import { loadDotEnv } from "./config.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapCloud, readCloudBootstrapInput } from "./cloud-bootstrap.js";
import { clientCommand } from "./client-cli.js";
import { serversCommand } from "./servers-cli.js";

async function main(): Promise<void> {
  loadDotEnv();
  const [command = "start", ...args] = process.argv.slice(2);
  if (command === "servers") { await serversCommand(args); return; }
  if (await clientCommand(command, args)) return;
  if (command === "cloud-bootstrap") {
    if (args.length || process.stdin.isTTY) throw new Error("cloud-bootstrap accepts its JSON payload only through stdin");
    if (process.env.OPENSTRUDEL_DB && resolve(process.env.OPENSTRUDEL_DB) !== resolve(".data/openstrudel.sqlite")) {
      throw new Error("Cloud bootstrap requires the installation's default database path");
    }
    console.log(JSON.stringify(await bootstrapCloud(await readCloudBootstrapInput(process.stdin))));
    return;
  }
  if (args.includes("--mock")) process.env.OPENSTRUDEL_CODEX_MODE = "mock";
  if (command === "pair") {
    const connection = JSON.parse(await readFile(".data/LocalConnection.json", "utf8")) as { url: string; token: string };
    const url = new URL(connection.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Local Home connection required");
    const response = await fetch(url + "v1/mobile/pairing", {
      method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" }, body: JSON.stringify({ owner: true }),
    });
    const invite = await response.json() as { url: string; error?: string };
    if (!response.ok) throw new Error(invite.error ?? "Could not create invitation");
    console.log("Откройте эту личную ссылку на Mac или iPhone. Она действует 5 минут и используется один раз.\n\n" + invite.url);
    return;
  }

  if (command === "doctor") {
    const runtime = new OpenStrudelRuntime({ startTelegram: false });
    console.log(JSON.stringify({
      service: "openstrudel",
      node: process.version,
      database: process.env.OPENSTRUDEL_DB ?? ".data/openstrudel.sqlite",
      codexMode: process.env.OPENSTRUDEL_CODEX_MODE ?? "codex",
      codexModel: process.env.OPENSTRUDEL_CODEX_MODEL ?? "gpt-6-astra",
      telegram: runtime.telegram.status(),
      employees: runtime.store.listProfiles().map((profile) => ({ id: profile.id, name: profile.name })),
    }, null, 2));
    await runtime.stop();
    return;
  }
  if (command !== "start") throw new Error(`unknown command: ${command}`);
  const runtime = new OpenStrudelRuntime();
  const address = await runtime.start();
  console.log(`OpenStrudel listening on http://${address.host}:${address.port}`);
  const stop = () => void runtime.stop().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
