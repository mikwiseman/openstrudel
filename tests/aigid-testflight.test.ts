import { describe, expect, it } from "vitest";
import { buildRequester } from "../src/aigid-testflight.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

const config = { telegram: ["10", "20"], devices: ["mik-mac", "grisha-mac"], accountEmail: "builder@example.com", repository: "example/app" };
const turn: TelegramToolContext = { channel: "api", byOwner: true, messageId: "m", conversationId: "c" };

describe("AiGid release requests", () => {
  it("requires the verified sender or individual paired device on an interactive turn", () => {
    expect(buildRequester(config, { ...turn, deviceId: "grisha-mac" })).toBe(true);
    expect(buildRequester(config, { ...turn, deviceId: "demo" })).toBe(false);
    expect(buildRequester(config, turn)).toBe(false);
    expect(buildRequester(config, { ...turn, deviceId: "mik-mac", byOwner: false })).toBe(false);
    const telegram = { ...turn, channel: "telegram" as const, telegramSenderId: "20" };
    expect(buildRequester(config, telegram)).toBe(true);
    expect(buildRequester(config, { ...telegram, telegramSenderId: "21" })).toBe(false);
    expect(buildRequester(config, { ...telegram, access: false })).toBe(false);
    expect(buildRequester(config, { ...telegram, scheduled: true })).toBe(false);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildQueue } from "../src/aigid-queue.js";

it("holds candidates until Xcode Cloud is enabled and never replays a dispatched request", () => {
  const root = mkdtempSync(join(tmpdir(), "wolf-testflight-"));
  const queue = new BuildQueue(root);
  try {
    queue.add("one", "chat", "telegram", "20", "Release", false);
    queue.add("one", "chat", "telegram", "20", "Release", false);
    expect(queue.next(false)?.id).toBe("one");
    queue.db.prepare("UPDATE jobs SET state='ready' WHERE id='one'").run();
    expect(queue.next(false)).toBeUndefined();
    expect(queue.next(true)?.id).toBe("one");
    queue.db.prepare("UPDATE jobs SET state='tagged' WHERE id='one'").run();
    expect(queue.next(true)).toBeUndefined();
  } finally { queue.db.close(); rmSync(root, { recursive: true, force: true }); }
});

import { candidateSummary } from "../src/aigid-candidate.js";

it("dispatches a build-only inspection while reserving implementation readiness for change requests", () => {
  expect(candidateSummary({notes:"Test the current map.", checks:"Native QA runs at Apple."}, false).notes).toBe("Test the current map.");
  expect(() => candidateSummary({notes:"Map change", checks:"Change incomplete.", ready:false}, true)).toThrow("Change incomplete");
  expect(() => candidateSummary({notes:""}, false)).toThrow();
});
