import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { Home } from "../src/home.js";
import { HomeLink } from "../src/home-link.js";
import { HomeApi } from "../src/home-api.js";
import { wireJSON } from "../src/home-transport.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function coordinator(mainElsewhere: boolean) {
  const store = new Store(":memory:"); stores.push(store);
  const home = new Home(store);
  if (mainElsewhere) {
    home.register({ id: "node-main", name: "Mini", platform: "darwin", protocol: 1, seenAt: Date.now() });
    home.save({ ...home.state, mainNodeId: "node-main" });
  }
  const forwarded: Array<{ nodeId: string; path: string; method: string }> = [];
  const link = new HomeLink(home, async () => wireJSON({}));
  link.call = async (nodeId, request) => { forwarded.push({ nodeId, path: request.path, method: request.method }); return wireJSON({ forwarded: true }); };
  const api = new HomeApi(home, link, async () => ({ url: "http://127.0.0.1:1" }));
  const get = (path: string) => api.handle({ url: path, method: "GET", headers: {} } as any, true, false);
  return { home, forwarded, get };
}

it("reads business clients through the main chat's runtime, as it reads the main chat, when that runtime is another node", async () => {
  const remote = coordinator(true);
  const list = await remote.get("/v1/clients?refresh=true");
  expect(list).toMatchObject({ status: 200 });
  const files = await remote.get("/v1/clients/c-acme/files?connector=company&endpoint=https%3A%2F%2Fx%2Fmcp&fingerprint=0123456789abcdef&offset=0");
  expect(files).toMatchObject({ status: 200 });
  expect(remote.forwarded).toEqual([
    { nodeId: "node-main", path: "/v1/clients?refresh=true", method: "GET" },
    { nodeId: "node-main", path: "/v1/clients/c-acme/files?connector=company&endpoint=https%3A%2F%2Fx%2Fmcp&fingerprint=0123456789abcdef&offset=0", method: "GET" },
  ]);
  // The same requests on a Home whose main chat runs here are answered here.
  const local = coordinator(false);
  expect(await local.get("/v1/clients")).toBeUndefined();
  expect(await local.get("/v1/clients/c-acme/files?offset=0")).toBeUndefined();
  expect(local.forwarded).toEqual([]);
  expect(randomUUID()).toBeTruthy();
});
