import { HomeError } from "./home.js";
import { assertAgentWritable } from "./agent-move.js";
import type { Store } from "./store.js";

/** Delete only this employee's product data. Shared workspace files belong to the user. */
export function deleteEmployee(store: Store, profileId: string) {
  if (profileId === "main") throw new HomeError("Общий помощник остаётся в приложении.", 400);
  assertAgentWritable(store, profileId);
  const profile = store.getProfile(profileId);
  if (!profile || profile.id !== profileId) throw new HomeError("Сотрудник уже удалён. Обновите список.", 404);
  const chats = store.listConversations().filter(c => c.profileId === profileId);
  const tables = new Set((store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name));
  const db = store.db;
  db.exec("SAVEPOINT delete_employee");
  try {
    for (const chat of chats) {
      if (db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(chat.id)
          || tables.has("schedule_runs") && db.prepare("SELECT 1 FROM schedule_runs WHERE conversation_id=? AND status IN ('running','ready') LIMIT 1").get(chat.id)) {
        throw new HomeError("Сотрудник выполняет поручение. Дождитесь завершения и повторите удаление.", 409);
      }
    }
    // A tombstone also rejects already queued remote commands after deletion.
    store.setSetting("employee.deleted." + profileId, new Date().toISOString());
    db.prepare("UPDATE telegram_chats SET profile_id=NULL,conversation_id=NULL WHERE profile_id=?").run(profileId);
    for (const chat of chats) {
      db.prepare("UPDATE telegram_chats SET profile_id=NULL,conversation_id=NULL WHERE conversation_id=?").run(chat.id);
      if (tables.has("schedules")) {
        db.prepare("UPDATE schedules SET backup_of=NULL WHERE backup_of IN (SELECT id FROM schedules WHERE conversation_id=?)").run(chat.id);
        for (const row of db.prepare("SELECT id FROM schedules WHERE conversation_id=?").all(chat.id)) store.deleteSetting("schedule.import." + row.id);
      }
      for (const table of ["schedule_runs", "schedules", "conversation_files", "messages", "conversations"]) {
        if (tables.has(table)) db.prepare(`DELETE FROM ${table} WHERE ${table === "conversations" ? "id" : "conversation_id"}=?`).run(chat.id);
      }
      store.deleteSetting("conversation.context." + chat.id);
    }
    db.prepare("DELETE FROM employee_profiles WHERE id=?").run(profileId);
    for (const key of ["employee.context.", "agent.accounts."]) store.deleteSetting(key + profileId);
    if (store.getSetting("telegram.link_profile") === profileId) {
      for (const key of ["telegram.link_profile", "telegram.link_hash", "telegram.link_expires_at"]) store.deleteSetting(key);
    }
    db.exec("RELEASE delete_employee");
  } catch (error) { db.exec("ROLLBACK TO delete_employee; RELEASE delete_employee"); throw error; }
}
