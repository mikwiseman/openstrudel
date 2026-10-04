import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CATALOG_URL = 'https://api.eqvps.com/api/v1/eqvps/products';
const MCP_URL = 'https://mcp.eqvps.com/mcp';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ORDER_TOOL = 'reseller_order_for_client';

export class ProbeError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// No arbitrary endpoint, generic tool-call method, or paid order method is exposed.
export class EqvpsProbe {
  constructor({ token, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    if (token !== undefined && !/^rk_[A-Za-z0-9_-]{8,512}$/.test(token)) {
      throw new ProbeError('invalid_token', 'Нужен партнёрский ключ EQVPS из Partners → API/MCP.');
    }
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #request(url, { body, authenticated = false, rpcId } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader;
    try {
      const response = await this.fetchImpl(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: body ? 'application/json, text/event-stream' : 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(authenticated && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 401 || response.status === 403 ? 'auth_required'
          : response.status === 429 ? 'rate_limited' : 'provider_http_error';
        throw new ProbeError(code, code === 'auth_required'
          ? 'Партнёрский API недоступен: проверьте аккаунт и ключ.'
          : 'EQVPS не завершил запрос. Повторите проверку позже.', response.status);
      }
      const contentType = response.headers.get('content-type') ?? '';
      const isSSE = /^text\/event-stream(?:;|$)/i.test(contentType);
      if (!isSSE && !/^application\/json(?:;|$)/i.test(contentType)) {
        await response.body?.cancel();
        throw new ProbeError('unexpected_content', 'Провайдер вернул неподдерживаемый формат ответа.');
      }
      if (isSSE && rpcId === undefined) {
        await response.body?.cancel();
        throw new ProbeError('unexpected_content', 'Каталог должен быть ответом JSON.');
      }
      reader = response.body?.getReader();
      if (!reader) throw new ProbeError('empty_response', 'Провайдер вернул пустой ответ.');
      const decoder = new TextDecoder();
      let received = 0;
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          received += value.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            throw new ProbeError('response_too_large', 'Ответ провайдера превышает допустимый размер.');
          }
          buffer += decoder.decode(value, { stream: true });
        }
        if (done) buffer += decoder.decode();
        if (isSSE) {
          // Return once our RPC response arrives; do not wait for an SSE connection to close.
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = done ? '' : blocks.pop();
          for (const block of blocks) {
            const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            const envelope = parseJSON(data);
            if (envelope?.id === rpcId) return unwrapRPC(envelope, rpcId);
          }
        } else if (done) {
          const parsed = parseJSON(buffer);
          return rpcId === undefined ? parsed : unwrapRPC(parsed, rpcId);
        }
        if (done) break;
      }
      throw new ProbeError('missing_rpc_response', 'Провайдер не вернул ответ на этот запрос.');
    } catch (error) {
      if (error instanceof ProbeError) throw error;
      if (controller.signal.aborted) {
        throw new ProbeError('timeout', 'Время ожидания истекло. Запрос не повторяется автоматически.');
      }
      // Upstream error messages can contain tokens, passwords, or customer information.
      throw new ProbeError('network_error', 'Не удалось связаться с EQVPS. Проверьте соединение.');
    } finally {
      clearTimeout(timer);
      if (reader) await reader.cancel().catch(() => {});
    }
  }

  async publicCatalog() {
    return selectHomeOffers(await this.#request(CATALOG_URL));
  }

  async #tools() {
    const all = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 10; page++) {
      const id = randomUUID();
      const result = await this.#request(MCP_URL, {
        authenticated: true, rpcId: id,
        body: { jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} },
      });
      if (!Array.isArray(result?.tools) || result.tools.some(tool => typeof tool?.name !== 'string')) {
        throw new ProbeError('invalid_tool_list', 'API вернул некорректный список возможностей.');
      }
      all.push(...result.tools);
      if (!result.nextCursor) return all;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) break;
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new ProbeError('incomplete_tool_list', 'Список возможностей API получен не полностью.');
  }

  async capabilities() {
    return describeCapabilities(await this.#tools(), Boolean(this.token));
  }

  async dryRun({ planId, clientId, osId } = {}) {
    if (!this.token) throw new ProbeError('partner_account_required', 'Для тестового заказа нужен партнёрский аккаунт и ключ.');
    const tools = await this.#tools();
    const tool = tools.find(entry => entry.name === ORDER_TOOL);
    const properties = tool?.inputSchema?.properties;
    if (!supportsDryRun(tool)) {
      throw new ProbeError('dry_run_not_advertised', 'API не подтвердил параметр test=true. Заказ не отправлен.');
    }
    const args = {
      plan_id: schemaIdentifier(planId, properties.plan_id),
      client_id: schemaIdentifier(clientId, properties.client_id),
      test: true,
    };
    if (osId !== undefined) args.os_id = schemaIdentifier(osId, properties.os_id);
    for (const key of tool.inputSchema.required ?? []) {
      if (!(key in args)) throw new ProbeError('additional_order_fields', 'API требует дополнительные поля. Сначала обновите адаптер.');
    }
    const id = randomUUID();
    const result = await this.#request(MCP_URL, {
      authenticated: true, rpcId: id,
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: ORDER_TOOL, arguments: args } },
    });
    if (result?.isError !== false && result?.isError !== undefined) {
      throw new ProbeError('dry_run_rejected', 'Провайдер отклонил тестовый запрос.');
    }
    if (!Array.isArray(result?.content)) {
      throw new ProbeError('invalid_tool_result', 'Провайдер вернул некорректный ответ на тестовый запрос.');
    }
    // Never print a tool's raw content: even test responses may contain access credentials.
    return {
      mode: 'provider_simulation',
      requestSentWithTestTrue: true,
      rpcAccepted: true,
      realServerVerified: false,
      paymentVerified: false,
    };
  }
}

function parseJSON(value) {
  try { return JSON.parse(value); }
  catch { throw new ProbeError('invalid_json', 'Провайдер вернул некорректный JSON.'); }
}

function unwrapRPC(envelope, id) {
  if (envelope?.jsonrpc !== '2.0' || envelope.id !== id) {
    throw new ProbeError('invalid_rpc', 'Ответ API не соответствует отправленному запросу.');
  }
  if (envelope.error) throw new ProbeError('rpc_error', 'API отклонил запрос; подробности провайдера скрыты для защиты данных.');
  if (!Object.hasOwn(envelope, 'result')) throw new ProbeError('invalid_rpc', 'В ответе API отсутствует результат.');
  return envelope.result;
}

function supportsDryRun(tool) {
  const schema = tool?.inputSchema;
  const test = schema?.properties?.test;
  return schema?.type === 'object' && test?.type === 'boolean'
    && (test.const === undefined || test.const === true)
    && (test.enum === undefined || (Array.isArray(test.enum) && test.enum.includes(true)));
}

export function describeCapabilities(tools, authenticated) {
  const order = tools.find(tool => tool.name === ORDER_TOOL);
  const properties = order?.inputSchema?.properties ?? {};
  return {
    authenticated,
    toolCount: tools.length,
    resellerOrderVisible: Boolean(order),
    dryRunAdvertised: supportsDryRun(order),
    sshKeyFieldAdvertised: Boolean(properties.ssh_key),
    cloudInitFieldAdvertised: Boolean(properties.user_data || properties.cloud_init),
    idempotencyFieldAdvertised: Boolean(properties.idempotency_key),
    readyForPaidProvisioning: false,
  };
}

function schemaIdentifier(value, schema) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ProbeError('invalid_order_identifier', 'Укажите идентификаторы существующих тестовых плана и клиента.');
  }
  if (schema?.type === 'integer' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  if (schema?.type === 'string') return value;
  throw new ProbeError('unknown_identifier_schema', 'Тип идентификатора не соответствует текущей схеме API.');
}

export function selectHomeOffers(catalog) {
  if (!Array.isArray(catalog?.data)) throw new ProbeError('invalid_catalog', 'Каталог EQVPS имеет неизвестный формат.');
  const offers = catalog.data.flatMap(product => {
    const specs = product?.specs;
    if (specs?.network !== 'dedicated' || !Number.isInteger(specs.ipv4) || specs.ipv4 < 1
      || !Number.isFinite(specs.memory_mb) || specs.memory_mb < 4096
      || !Number.isFinite(specs.disk_gb) || specs.disk_gb < 30
      || !Number.isInteger(product.id) || typeof product.slug !== 'string') return [];
    const os = product.available_os?.find(entry => entry.name === 'Ubuntu 24.04' && Number.isInteger(entry.id) && entry.id > 0);
    const plan = product.plans?.find(entry => entry.period === 'month' && entry.currency === 'USD'
      && Number.isFinite(entry.amount) && entry.amount > 0 && Number.isInteger(entry.plan_id));
    if (!os || !plan) return [];
    return [{
      product: product.slug, publicPlanId: plan.plan_id, osId: os.id,
      memoryMiB: specs.memory_mb, diskGB: specs.disk_gb,
      dedicatedIPv4: true, monthlyUSD: plan.amount,
    }];
  }).sort((a, b) => a.monthlyUSD - b.monthlyUSD || a.product.localeCompare(b.product));
  return {
    pricingBasis: 'public_retail_catalog_not_reseller_quote',
    capacityVerified: false,
    offers,
    recommendedReference: offers[0] ?? null,
  };
}

export async function readPartnerToken(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new ProbeError('unsafe_token_file', 'Файл ключа должен принадлежать вам и иметь права 600 или 400.');
    }
    return (await file.readFile('utf8')).trim();
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('token_file_unavailable', 'Не удалось открыть локальный файл партнёрского ключа.');
  } finally {
    await file?.close();
  }
}
