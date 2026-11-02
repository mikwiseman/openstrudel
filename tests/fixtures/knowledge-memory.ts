// Runs in a small-heap child: exporting a history larger than the heap must succeed.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/store.js";
import { ownerKnowledge } from "../../src/knowledge.js";
import { MessageService } from "../../src/messages.js";

const root = process.argv[2]!;
const store = new Store(join(root, "test.sqlite"));
const employee = store.createProfile({ name: "Historical source", instructions: "Use the source." });
const chat = store.profileConversation(employee.id);
const payload = "Historical evidence. ".repeat(500);
const count = 8_000;
const insert = store.db.prepare("INSERT INTO messages(id,conversation_id,channel,direction,text,created_at,imported) VALUES(?,?,'api','inbound',?,?,1)");
store.db.exec("BEGIN");
for (let index = 0; index < count; index++) insert.run(`m${index}`, chat.id, `${index}: ${payload}`, new Date(index * 1000).toISOString());
store.db.exec("COMMIT");
ownerKnowledge(store, root, () => "personal");
const catalog = JSON.parse(readFileSync(join(root, ".data/owner-knowledge/catalog.json"), "utf8"));
const source = catalog.sources.find((row: { conversationId: string }) => row.conversationId === chat.id);
let prompt = "";
const service = new MessageService(store, { async run(input) { prompt = input; return { threadId: "test", response: "ok", events: [] }; } }, root);
try {
  await service.handle({ channel: "api", profile: employee.id, text: "Use prior evidence", byOwner: true });
  const archive = join(root, ".data/workspace", service.contextFor(chat.id), "history", chat.id, "telegram.jsonl");
  process.stdout.write(JSON.stringify({ messages: source.messages, bytes: statSync(source.history).size, archiveBytes: statSync(archive).size,
    promptHasRange: prompt.includes("8000 messages, 1970-01-01T00:00:00.000Z to 1970-01-01T02:13:19.000Z"),
    heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss }));
} finally { await service.close(); store.close(); }
