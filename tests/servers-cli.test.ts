import { describe, expect, it } from "vitest";
import { ServersClient } from "../src/servers-cli.js";

const quote = { amount: 1200, currency: "usd", period_days: 30 };
const intent = { purpose: "clean", payment_method: "card", idempotency_key: "one-server-one-intent", quote, consent: true };
function fixture(options: { enabled?: boolean; version?: number; amount?: number } = {}) {
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const client = new ServersClient({ origin: "https://hosting.example", key: "private-fixture-key" }, (async (url, init) => {
    requests.push({ url: String(url), options: init });
    return Response.json(String(url).endsWith("/catalog") ? { client_quote_version: options.version ?? 1, plan: { checkout_enabled: options.enabled ?? true, period_days: 30 }, payment_methods: [{ id: "card", available: true, currency: "usd", amount: options.amount ?? 1200 }] } : { id: "same-order" });
  }) as typeof fetch);
  return { client, requests };
}
describe("server purchases from the universal CLI", () => {
  it("requires exact current price consent and preserves the caller's stable order identity", async () => {
    const { client, requests } = fixture();
    expect(await client.order(intent)).toEqual({ id: "same-order" });
    expect(await client.order(intent)).toEqual({ id: "same-order" });
    const writes = requests.filter(r => r.options?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes.map(r => r.options?.body)).toEqual([JSON.stringify(intent), JSON.stringify(intent)]);
    expect(writes.every(r => r.options?.redirect === "error")).toBe(true);
    expect(requests.some(r => r.url.includes("checkout"))).toBe(false);
  });
  it.each([{ amount: 1300 }, { enabled: false }, { version: 0 }])("does not create an order if the quote or capability changes: %j", async options => {
    const { client, requests } = fixture(options);
    await expect(client.order(intent)).rejects.toThrow();
    expect(requests.every(r => r.options?.method === "GET")).toBe(true);
  });
  it("rejects unsafe origins and never follows redirects with the personal key", async () => {
    for (const value of ["http://public.example", "https://user:pass@hosting.example", "https://hosting.example/path", "https://hosting.example/?token=secret"]) expect(() => new ServersClient({ origin: value, key: "private" })).toThrow();
    const seen: RequestInit[] = [];
    const client = new ServersClient({ origin: "https://hosting.example", key: "private" }, (async (_url, init) => { seen.push(init!); return new Response(null, { status: 302, headers: { location: "https://other.example" } }); }) as typeof fetch);
    await expect(client.request("/me")).rejects.toThrow("не перенаправлялся");
    expect(seen).toHaveLength(1); expect(seen[0]?.redirect).toBe("error");
  });
});
