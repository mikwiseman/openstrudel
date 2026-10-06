import { HomeError, HOME_PROTOCOL, endpoint, identifier, object, type HomeState } from "./home.js";

const bad = () => { throw new HomeError("Копия управления повреждена или несовместима."); };
const list = (value: unknown, max: number): any[] => { if (!Array.isArray(value) || value.length > max) return bad(); return value; };
const text = (value: unknown, max: number): string => { if (typeof value !== "string" || value.length > max) return bad(); return value; };
const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) return bad(); return Number(value); };
const json = (value: unknown, max: number) => { try { return JSON.parse(text(value, max)); } catch { return bad(); } };
const hash = (value: unknown): string => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return bad(); return value; };

/** Validate before either staging or writing a restored catalogue. No arbitrary settings. */
export function validateSnapshot(input: unknown): any {
  const value = object(input), state = object(value.state);
  if (value.format !== "openstrudel.home" || value.version !== HOME_PROTOCOL || state.role !== "primary") bad();
  for (const key of ["id", "nodeId", "primaryId", "mainNodeId"]) identifier(state[key]);
  if (state.mainAgentId !== undefined) identifier(state.mainAgentId);
  if (state.nodeId !== state.primaryId || integer(state.epoch) < 1) bad();
  text(state.name, 120); text(value.createdAt, 100);
  const nodeIds = new Set<string>(), tokenHashes = new Set<string>();
  for (const row of list(value.nodes, 100)) {
    identifier(row.id); if (nodeIds.has(row.id)) bad(); nodeIds.add(row.id);
    const info = object(json(row.info, 4096));
    if (info.id !== row.id || info.protocol !== HOME_PROTOCOL || !text(info.name, 120)) bad();
    text(info.platform, 30); integer(info.seenAt);
    if (info.endpoint) endpoint(info.endpoint);
    if (row.token_hash !== null) { hash(row.token_hash); if (tokenHashes.has(row.token_hash)) bad(); tokenHashes.add(row.token_hash); }
  }
  if (!nodeIds.has(state.primaryId) || !nodeIds.has(state.mainNodeId)) bad();
  const resourceIds = new Set<string>();
  for (const row of list(value.resources, 100_000)) {
    if (!["profile", "conversation", "file"].includes(row.kind) || !nodeIds.has(row.node_id)) bad();
    identifier(row.id); const key = row.kind + ":" + row.id;
    if (resourceIds.has(key)) bad(); resourceIds.add(key);
    const data = object(json(row.data, 1_048_576));
    if (row.kind !== "file" && data.id !== row.id) bad();
  }
  const commandIds = new Set<string>();
  for (const row of list(value.commands, 100_000)) {
    identifier(row.id); if (commandIds.has(row.id) || !nodeIds.has(row.node_id)) bad(); commandIds.add(row.id);
    const request = object(json(row.request, 280 * 1024 * 1024));
    if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method) || typeof request.owner !== "boolean" || !text(request.path, 4096).startsWith("/v1/")) bad();
    // A control backup cannot carry an activation command from a different transfer.
    if (request.path.startsWith("/v1/home/") && row.response === null && row.canceled === 0) bad();
    if (request.body !== undefined) text(request.body, 280 * 1024 * 1024);
    if (row.request_hash != null) hash(row.request_hash);
    integer(row.created_at); if (row.finished_at != null) integer(row.finished_at);
    if (row.canceled !== 0 && row.canceled !== 1) bad();
    if (row.dispatched != null && row.dispatched !== 0 && row.dispatched !== 1) bad();
    if (row.response !== null) {
      const response = object(json(row.response, 280 * 1024 * 1024));
      if (integer(response.status) < 100 || response.status > 599) bad();
      text(response.body, 280 * 1024 * 1024); text(response.contentType, 200);
    }
  }
  const keys = new Set<string>();
  for (const row of list(value.access, 3)) {
    if (!["mobile.tokens", "mobile.owners", "mobile.clients"].includes(row.key) || keys.has(row.key)) bad(); keys.add(row.key);
    const entries = list(json(row.value, 1_048_576), 1000);
    if (row.key !== "mobile.clients") for (const entry of entries) hash(entry);
  }
  return value as { state: HomeState } & Record<string, any>;
}
