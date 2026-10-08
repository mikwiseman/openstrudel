import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { EmployeeProfile } from '../src/types.js';
const wire = vi.hoisted(() => ({ request: vi.fn(), notify: undefined as any, incoming: undefined as any }));
vi.mock('../src/rpc.js', () => ({ CodexRpc: class {
  closed = false;
  constructor(_home: unknown, notify: any, incoming: any) { wire.notify = notify; wire.incoming = incoming; }
  initialize = async () => undefined;
  request = wire.request;
  close() { this.closed = true; }
} }));
import { CodexEngineAdapter } from '../src/codex.js';
import { employeeRoleConfig } from '../src/employee-routing.js';
const folders: string[] = [];
const employee: EmployeeProfile = { id: 'editor', name: 'Редактор', purpose: 'Редактура', instructions: 'Пиши ясно.', capabilities: [], model: 'other-model', tokenLimit: null, createdAt: '2026-10-08' };
function home() { const dir = mkdtempSync(join(tmpdir(), 'strudel-roles-')); folders.push(dir); return dir; }
afterEach(() => { wire.request.mockReset(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
let child = '';
function fixture() {
  // Codex documents native thread IDs as UUIDv7 (millisecond creation time).
  child = (Date.now() + 1000).toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2') + '-7000-8000-000000000001';
  wire.request.mockImplementation(async (method: string, params: any) => {
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId ?? 'parent' } };
    if (method === 'thread/read') return { thread: { parentThreadId: params.threadId === child || params.threadId === '00000000-0000-7000-8000-000000000001' ? 'parent' : null } };
    if (method === 'thread/unsubscribe' || method === 'thread/inject_items') return {};
    if (method === 'turn/start') return { turn: { id: 'turn' } };
    throw new Error(method);
  });
}
function complete(threadId = 'parent') {
  wire.notify({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: 'Result here' } } });
  wire.notify({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
}
it('keeps an immutable specialist and originating rules, without inheriting personal credentials or model overrides', () => {
  const dir = home();
  const first = employeeRoleConfig(dir, [employee], 'Group A requires explicit confirmation.').agents as any;
  const role = Object.values(first).find((r: any) => r?.config_file) as any;
  const content = readFileSync(role.config_file, 'utf8');
  const second = employeeRoleConfig(dir, [employee], 'Group B rules.').agents as any;
  expect(readFileSync(role.config_file, 'utf8')).toBe(content);
  expect(JSON.stringify(second)).not.toContain(role.config_file);
  expect(Object.keys(parse(content))).toEqual(['developer_instructions']);
  expect(content).toContain('Group A requires explicit confirmation.');
  expect(content).not.toContain('other-model');
  expect(first.max_threads).toBe(2);
});
it('resolves a native helper approval to its actual active parent and denies unrelated or late requests', async () => {
  fixture();
  const onRequest = vi.fn(async () => ({ action: 'accept', content: null }));
  const engine = new CodexEngineAdapter({ codexHome: home() });
  const run = engine.run('Review', { employees: [employee], onRequest });
  await vi.waitFor(() => expect(wire.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(true));
  expect(await wire.incoming('mcpServer/elicitation/request', { threadId: child, turnId: 'helper-turn' })).toEqual({ action: 'accept', content: null });
  expect(onRequest).toHaveBeenCalledTimes(1);
  await expect(wire.incoming('mcpServer/elicitation/request', { threadId: 'stranger' })).rejects.toThrow('No user');
  await expect(wire.incoming('mcpServer/elicitation/request', { threadId: '00000000-0000-7000-8000-000000000001' })).rejects.toThrow('No user');
  complete(); expect((await run).response).toBe('Result here');
  expect(wire.request.mock.calls).toContainEqual(['thread/unsubscribe', { threadId: child }, 2_000]);
  await expect(wire.incoming('mcpServer/elicitation/request', { threadId: child })).rejects.toThrow('No user');
  expect(onRequest).toHaveBeenCalledTimes(1);
  engine.close();
});
it('releases a helper announced by native activity even when it needed no approvals', async () => {
  fixture(); const engine = new CodexEngineAdapter({ codexHome: home() });
  const run = engine.run('Review', { employees: [employee] });
  await vi.waitFor(() => expect(wire.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(true));
  wire.notify({ method: 'item/completed', params: { threadId: 'parent', item: { type: 'subAgentActivity', kind: 'completed', agentThreadId: child } } });
  complete(); await run;
  expect(wire.request.mock.calls).toContainEqual(['thread/unsubscribe', { threadId: child }, 2_000]);
  expect(wire.request.mock.calls.filter(([m]) => m === 'thread/unsubscribe')).toHaveLength(1);
  engine.close();
});
it('runs allowed helper tools only in the parent scope and prevents permanent identity changes', async () => {
  fixture(); const call = vi.fn(async () => ({ scope: 'group-A' }));
  const engine = new CodexEngineAdapter({ codexHome: home() });
  const run = engine.run('Review', { employees: [employee], tools: { definitions: [], call } });
  await vi.waitFor(() => expect(wire.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(true));
  expect(await wire.incoming('item/tool/call', { threadId: child, tool: 'list_connections' })).toMatchObject({ success: true });
  expect(await wire.incoming('item/tool/call', { threadId: child, tool: 'update_employee' })).toMatchObject({ success: false });
  expect(await wire.incoming('item/tool/call', { threadId: child, tool: 'create_employee' })).toMatchObject({ success: false });
  expect(call).toHaveBeenCalledTimes(1);
  complete(); await run; engine.close();
});
it('removes delegation when the last employee is deleted and refreshes the native turn on resume', async () => {
  fixture(); const engine = new CodexEngineAdapter({ codexHome: home() });
  const first = engine.run('Review', { employees: [employee] });
  await vi.waitFor(() => expect(wire.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(true));
  const start = wire.request.mock.calls.find(([m]) => m === 'turn/start')![1];
  expect(start.multiAgentMode).toBe('proactive'); complete(); await first;
  wire.request.mockClear();
  const second = engine.run('Again', { threadId: 'parent', employees: [] });
  await vi.waitFor(() => expect(wire.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(true));
  expect(wire.request.mock.calls.find(([m]) => m === 'thread/resume')![1].config['features.multi_agent']).toBe(false);
  expect(wire.request.mock.calls.map(([m]) => m)).toContain('thread/unsubscribe');
  complete(); await second; engine.close();
});
