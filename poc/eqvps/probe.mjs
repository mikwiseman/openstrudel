#!/usr/bin/env node
import { EqvpsProbe, ProbeError, readPartnerToken } from './provider.mjs';

const usage = `Проверка EQVPS для OpenStrudel, без создания платного сервера.

node poc/eqvps/probe.mjs
node poc/eqvps/probe.mjs --token-file /private/path/eqvps-token
node poc/eqvps/probe.mjs --token-file /private/path/eqvps-token --dry-run --plan-id ID --client-id ID [--os-id ID]

Ключ храните в отдельном файле с правами 600. Не передавайте его аргументом.
--dry-run требует существующих тестовых клиента и плана. Их создание не выполняется.
Ответы с root-паролями, токенами или данными клиента не выводятся.
`;

try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage); process.exit(0); }
  const options = new Map();
  const withValue = new Set(['--token-file', '--plan-id', '--client-id', '--os-id']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (options.has(arg)) throw new ProbeError('invalid_arguments', 'Параметр указан несколько раз. Используйте --help.');
    if (arg === '--dry-run') { options.set(arg, true); continue; }
    if (!withValue.has(arg) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new ProbeError('invalid_arguments', 'Неизвестный параметр или пропущено значение. Используйте --help.');
    }
    options.set(arg, args[++index]);
  }
  if (options.has('--dry-run') && (!options.has('--token-file') || !options.has('--plan-id') || !options.has('--client-id'))) {
    throw new ProbeError('invalid_arguments', 'Для dry-run нужны --token-file, --plan-id и --client-id.');
  }
  if (!options.has('--dry-run') && ['--plan-id', '--client-id', '--os-id'].some(key => options.has(key))) {
    throw new ProbeError('invalid_arguments', 'Идентификаторы заказа используются только с --dry-run.');
  }
  const token = options.has('--token-file') ? await readPartnerToken(options.get('--token-file')) : undefined;
  const client = new EqvpsProbe({ token });
  const [catalog, capabilities] = await Promise.all([client.publicCatalog(), client.capabilities()]);
  const report = {
    checkedAt: new Date().toISOString(),
    mode: options.has('--dry-run') ? 'provider_simulation' : 'read_only',
    catalog, capabilities,
    realServerVerified: false,
    blockers: [
      ...(!token ? ['partner_account_and_key_required'] : []),
      ...(!capabilities.resellerOrderVisible ? ['reseller_order_schema_unavailable'] : []),
      ...(!capabilities.cloudInitFieldAdvertised ? ['bootstrap_transport_not_verified'] : []),
      'wholesale_price_and_provider_terms_need_confirmation',
      'fresh_budget_and_live_infrastructure_acceptance_required',
    ],
  };
  if (options.has('--dry-run')) {
    report.dryRun = await client.dryRun({ planId: options.get('--plan-id'), clientId: options.get('--client-id'), osId: options.get('--os-id') });
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const safe = error instanceof ProbeError ? { code: error.code, message: error.message, ...(error.status ? { status: error.status } : {}) }
    : { code: 'unexpected_error', message: 'Проверка не завершена. Подробности скрыты для защиты данных.' };
  console.error(JSON.stringify({ ok: false, error: safe }));
  process.exitCode = 1;
}
