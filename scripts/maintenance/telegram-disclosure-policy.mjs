/** One-off correction for the three exact overbroad clauses installed on 2026-11-02.
 * Apply only to inspected SOUL/profile/schedule instructions, never to message bodies or delivery formatting.
 * This module plans text changes only; it does not access a database, send messages, or restart a service.
 */
export const personalAccountDisclosureRule = "When AI sends an outbound Telegram message through Mik's personal account on his behalf, that outbound message text must include _Отправлено AI-помощником._ exactly once (translated to the message language). Do not append an outer disclosure to messages sent by a Telegram bot: direct replies, statuses, scheduled reminders, insights and bot-chat draft previews have no footer, including when discussing a future message from Mik. Preserve disclosure already inside the exact text explicitly prepared for a personal-account send; do not add a second footer to the surrounding bot reply. Do not rewrite existing approved drafts, old messages, or quoted/transcribed text to apply this rule.";

const botReminderRule = "This reminder is delivered by the connected Telegram bot, so do not append a personal-account AI-disclosure footer.";

const replacements = [
  ["Every AI-authored Telegram reply or scheduled insight ends once with a blank line and _Отправлено AI-помощником._ (translated to the message language).", personalAccountDisclosureRule],
  ["Every Telegram reminder ends with a blank line and _Отправлено AI-помощником._.", botReminderRule],
  ["Every non-quiet reminder ends with a blank line and _Отправлено AI-помощником._.", botReminderRule],
];

export function correctTelegramDisclosure(instructions) {
  if (typeof instructions !== "string") throw new TypeError("Instructions must be text");
  let text = instructions;
  const changes = [];
  for (const [before, after] of replacements) {
    const count = text.split(before).length - 1;
    if (!count) continue;
    text = text.split(before).join(after);
    changes.push({ before, after, count });
  }
  return { text, changes, clauseCount: changes.reduce((sum, change) => sum + change.count, 0) };
}
