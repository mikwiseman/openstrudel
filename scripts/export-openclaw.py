#!/usr/bin/env python3
"""Read-only, credential-free employee/history export. Run on the source host."""
import glob
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

config = json.load(open('/root/.openclaw/openclaw.json'))
account_name = os.environ.get('STRUDEL_SOURCE_ACCOUNT', 'default')
account = config['channels']['telegram']['accounts'][account_name]
databases = []
for path in glob.glob('/root/.openclaw/agents/*/agent/openclaw-agent.sqlite'):
    db = sqlite3.connect('file:' + path + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    databases.append((path, db))

def clean(text):
    text = re.sub(r'\b\d{8,12}:[A-Za-z0-9_-]{30,}\b', '[credential removed]', text)
    return re.sub(r'\b(?:sk-|ghp_|github_pat_|wai_ops_)[A-Za-z0-9_-]{16,}\b', '[credential removed]', text)

def message(event, source):
    item = event.get('message', event)
    role = item.get('role')
    if role not in ('user', 'assistant'):
        return None
    content = item.get('content', '')
    if isinstance(content, list):
        content = '\n'.join(x.get('text', '') for x in content if x.get('type') == 'text')
    if not isinstance(content, str) or not content.strip():
        return None
    # Do not replay internal wakeups as user instructions.
    if role == 'user' and re.match(r'^(?:HEARTBEAT|Read HEARTBEAT\.md|\[System Message\]|\[System\])', content.strip()):
        return None
    stamp = event.get('timestamp', item.get('timestamp'))
    if isinstance(stamp, (int, float)):
        stamp = datetime.fromtimestamp(stamp / (1000 if stamp > 1e11 else 1), timezone.utc).isoformat()
    if not stamp:
        return None
    author = item.get('sender', {}).get('name') if isinstance(item.get('sender'), dict) else None
    return dict(sourceId=source, date=str(stamp), author=author or ('Участник Telegram' if role == 'user' else 'Сотрудник'), direction='inbound' if role == 'user' else 'outbound', text=clean(content))

employees = []
for chat_id, group in account.get('groups', {}).items():
    if chat_id == '*' or not group.get('enabled', True):
        continue
    nodes = []
    for path, db in databases:
        for row in db.execute('SELECT session_key,current_session_id,entry_json FROM session_nodes WHERE session_key LIKE ?', ('%:telegram:group:' + chat_id,)):
            entry = json.loads(row['entry_json'])
            nodes.append((path, db, row, entry))
    title = next((entry.get('subject') or entry.get('origin', {}).get('label') or entry.get('displayName') for _, _, _, entry in reversed(nodes) if entry.get('subject') or entry.get('displayName')), None)
    history = []
    for path, db, node, entry in nodes:
        for row in db.execute('SELECT seq,event_json,created_at FROM transcript_events WHERE session_id=? ORDER BY seq', (node['current_session_id'],)):
            event = json.loads(row['event_json'])
            event.setdefault('timestamp', row['created_at'])
            parsed = message(event, account_name + ':' + chat_id + ':' + node['current_session_id'] + ':' + str(row['seq']))
            if parsed:
                history.append(parsed)
    history.sort(key=lambda m: m['date'])
    employees.append(dict(sourceId=account_name + ':' + chat_id, chatId=chat_id, title=title, instructions=clean(group.get('systemPrompt', '')), history=history, historySessions=len(nodes), requireMention=group.get('requireMention', True), skills=group.get('skills', [])))

state = sqlite3.connect('file:/root/.openclaw/state/openclaw.sqlite?mode=ro', uri=True)
jobs = [json.loads(row[0]) for row in state.execute('SELECT job_json FROM cron_jobs WHERE enabled=1')]
# Only fields needed for the new clock, never runtime/tool authority or credentials.
schedules = [dict(id=j.get('id'), name=j.get('name'), agentId=j.get('agentId'), schedule=j.get('schedule'), payload=j.get('payload'), delivery=j.get('delivery')) for j in jobs]
workspace = config.get('agents', {}).get('defaults', {}).get('workspace', '/root/.openclaw/workspace')
context = {}
for name in ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md']:
    path = os.path.join(workspace, name)
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as handle:
            context[name] = clean(handle.read())
print(json.dumps(dict(version=1, exportedAt=datetime.now(timezone.utc).isoformat(), account=account_name, employees=employees, schedules=schedules, workspaceContext=context), ensure_ascii=False))
