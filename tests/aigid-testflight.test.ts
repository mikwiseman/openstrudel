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

it("one delivery creates one durable request and a stale worker cannot reopen a released build", () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-testflight-"));
  const q=new BuildQueue(root);
  try {
    q.add("one","chat","telegram","20","Release",false);
    q.add("one","chat","telegram","20","Release",false);
    expect(q.next()?.id).toBe("one");
    expect(q.worker({action:"list"})).toEqual([]);
    q.db.prepare("UPDATE jobs SET state='ready',commit_sha=? WHERE id='one'").run("a".repeat(40));
    const rows=q.worker({action:"list"}) as Record<string,unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("goal");
    expect(()=>q.worker({action:"report",id:"one",state:"external",detail:"Premature"})).toThrow();
    for(const state of ["building","team","external"]) q.worker({action:"report",id:"one",state,detail:state});
    expect(()=>q.worker({action:"report",id:"one",state:"building",detail:"stale"})).toThrow();
    expect(q.worker({action:"list"})).toEqual([]);
  } finally {q.db.close();rmSync(root,{recursive:true,force:true});}
});
