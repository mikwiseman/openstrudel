import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { HomeError } from "./home.js";
import { readInput } from "./client-cli.js";

type Access = { origin: string; key: string };
const location = () => process.env.OPENSTRUDEL_SERVERS_CONFIG ?? resolve(homedir(), ".config/openstrudel/servers.json");
function origin(value: unknown) {
  if (typeof value !== "string") throw new HomeError("Укажите HTTPS-адрес магазина размещения.");
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new HomeError("Нужен точный HTTPS origin без пути и пароля.");
  return url.origin;
}
export class ServersClient {
  readonly address: string;
  constructor(readonly access: Access, private readonly transport: typeof fetch = fetch) { this.address = origin(access.origin); }
  async request(route: string, method = "GET", body?: unknown, binary = false): Promise<any> {
    const response = await this.transport(this.address + "/api/v1" + route, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: "Bearer " + this.access.key, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300 && response.status < 400) throw new HomeError("Адрес магазина изменился. Подключите проверенный новый адрес; ключ не перенаправлялся.");
    if (binary && response.ok) return Buffer.from(await response.arrayBuffer());
    const result = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new HomeError(response.status === 401 ? "Доступ к размещению истёк. Подключитесь заново." : result.error ?? "Магазин временно не отвечает.", response.status);
    return result;
  }
  async order(value: any) {
    if (!value || !["agent", "site", "clean"].includes(value.purpose) || !/^[-a-zA-Z0-9_]{8,100}$/.test(value.idempotency_key ?? "") || value.consent !== true) throw new HomeError("Укажите назначение, постоянный idempotency_key и согласие с ценой из servers catalog.");
    const catalog = await this.request("/catalog"), method = catalog.payment_methods.find((m: any) => m.id === value.payment_method);
    if (catalog.client_quote_version !== 1) throw new HomeError("Магазин ещё не поддерживает проверку суммы из приложения. Покупка появится после его обновления.", 409);
    const quote = value.quote;
    if (!catalog.plan.checkout_enabled || !method?.available || !quote || quote.amount !== method.amount || quote.currency !== method.currency || quote.period_days !== catalog.plan.period_days) throw new HomeError("Цена или доступность изменились. Проверьте servers catalog и подтвердите новую сумму.", 409);
    // The server validates these same terms atomically when accepting the order.
    return this.request("/orders", "POST", value);
  }
}
export async function serversCommand(args: string[]) {
  const clean = args.filter(a => a !== "--json"), [action = "help", id] = clean;
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (action === "help") {
    console.log("OpenStrudel · серверы\n\nservers connect                     подключение через JSON stdin: origin, key\nservers catalog | list | status ID\nservers order                       JSON stdin: purpose, payment_method, idempotency_key, consent, quote\nservers order-status ID | checkout ID\nservers cancel-at-end ID | keep ID\nservers access ID --output FILE\nservers delete ID --confirm ID\n\nКлюч принадлежит вашему аккаунту размещения. Ключ оператора не нужен.\nЗаказ не подтверждает оплату. Откройте checkout URL сами и проверьте order-status.\nquote содержит amount в минимальных денежных единицах, currency и period_days из catalog.\nПовтор неизвестного заказа использует прежний idempotency_key. --json подходит для скриптов."); return;
  }
  if (action === "connect") {
    const input = JSON.parse(await readInput()), config: Access = { origin: origin(input.origin), key: String(input.key ?? "") };
    if (!/^wai_(test|live)_[a-f0-9]{64}$/.test(config.key)) throw new HomeError("Нужен личный API-ключ размещения, выданный владельцу.");
    await new ServersClient(config).request("/me");
    const file = location(); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(config), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
    output({ connected: true, origin: config.origin }); return;
  }
  let config: Access;
  try { config = JSON.parse(await readFile(location(), "utf8")); } catch { throw new HomeError("Сначала выполните openstrudel servers connect. Приглашение команды и доступ к размещению — разные подключения."); }
  const client = new ServersClient(config);
  const uuid = () => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id ?? "")) throw new HomeError("Укажите точный UUID сервера или заказа."); return id!; };
  if (action === "catalog") output(await client.request("/catalog"));
  else if (action === "list") { const value = await client.request("/me"); output({ servers: value.servers, orders: value.orders, mode: value.mode }); }
  else if (action === "status") output(await client.request("/servers/" + uuid()));
  else if (action === "order") output(await client.order(JSON.parse(await readInput())));
  else if (action === "order-status") output(await client.request("/orders/" + uuid()));
  else if (action === "checkout") output(await client.request("/orders/" + uuid() + "/checkout", "POST", {}));
  else if (["cancel-at-end", "keep"].includes(action)) output(await client.request("/servers/" + uuid() + "/cancellation", "POST", { cancel_at_end: action === "cancel-at-end" }));
  else if (action === "delete") {
    const server = uuid();
    if (clean[2] !== "--confirm" || clean[3] !== server || clean.length !== 4) throw new HomeError("Удаление безвозвратно. Подтвердите точный сервер: servers delete ID --confirm ID.");
    output(await client.request("/servers/" + server + "/delete", "POST", { confirm: server }));
  } else if (action === "access") {
    if (clean[2] !== "--output" || !clean[3] || clean.length !== 4) throw new HomeError("Укажите новый файл --output FILE. Закрытый ключ не выводится в терминал.");
    const bytes = await client.request("/servers/" + uuid() + "/access", "POST", {}, true), file = resolve(clean[3]);
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" }); output({ saved: file });
  } else throw new HomeError("Неизвестная команда. Откройте openstrudel servers help.");
}
