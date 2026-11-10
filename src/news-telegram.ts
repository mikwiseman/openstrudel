import type { Store } from "./store.js";
import type { TelegramAdapter } from "./telegram.js";
import type { NewsStory } from "./types.js";
import { ownerTimezone } from "./timezone.js";
import { latestStories, page, savedEdition, storyPost, telegramTimes, type EditionSelection } from "./news.js";

/** The desk's Telegram posts. The application writes each one from the stored story and sends it once, so the reader sees one shape
 * whichever model wrote the story, and a run that stops after publishing has still delivered. */

const ALERTS_A_DAY = 2;
const SAME_SOURCE_DAYS = 7;
const LEAD_STORIES = 5;
const LINKS = 3;
/** A rich message holds 32,768 characters; the rest is room for what Telegram counts differently. */
const EDITION_CHARACTERS = 30_000;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const paragraphs = (text: string) => text.split(/\n\s*\n/).map(oneLine).filter(Boolean);
const russian = (text: string) => /[а-яё]/i.test(text);
/** Story text is plain. Only what Markdown would read as formatting is escaped, so the copy the Home keeps of a post reads as the
 * post does: marks inside a line, and a line's first character when it would start a heading, a quote, a list or a rule. */
const plain = (text: string) => text.replace(/[\\`*_[\]<>&~|]/g, "\\$&").replace(/^(\s*)([#+\-=]|\d+(?=[.)]))/gm, (_, space: string, mark: string) =>
  /^\d/.test(mark) ? `${space}${mark}\\` : `${space}\\${mark}`);
const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attribute = (text: string) => html(text).replace(/"/g, "&quot;");

/** A link reads as its publisher: the source's own short title, or the site when the title is a sentence. */
function label(source: NewsStory["sources"][number]): string {
  const title = oneLine(source.title);
  return title.length <= 32 ? title : new URL(source.url).hostname.replace(/^www\./, "");
}
const links = (story: NewsStory) => story.sources.slice(0, LINKS);

const localDate = (at: Date, zone: string | null) => new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const locale = (inRussian: boolean) => inRussian ? "ru-RU" : "en-US";

/** The event's day, with its hour when the story knows it and the owner's time zone is known. */
function eventDay(story: NewsStory, zone: string | null): string | null {
  const at = story.eventAt;
  if (!at) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(at), date = new Date(dateOnly ? at + "T12:00:00Z" : at);
  if (Number.isNaN(date.getTime())) return null;
  const timed = !dateOnly && zone != null;
  return new Intl.DateTimeFormat(locale(russian(story.title)), { timeZone: timed ? zone : "UTC", day: "numeric", month: "long", ...timed ? { hour: "2-digit", minute: "2-digit" } : {} }).format(date);
}

const footer = (story: NewsStory, zone: string | null) =>
  [...links(story).map(source => `[${plain(label(source))}](<${source.url}>)`), eventDay(story, zone)].filter(Boolean).join(" · ");

/** A story as one post: what happened in bold, the account in short paragraphs, why it matters after an arrow, then where it comes from. */
export function storyCard(story: NewsStory, zone: string | null): string {
  return [`**${plain(oneLine(story.title))}**`, ...paragraphs(story.summary).map(plain), story.view ? `→ ${plain(oneLine(story.view))}` : null, footer(story, zone)]
    .filter(Boolean).join("\n\n");
}

/** A development, sent as a reply under the story's first post: the reply already shows the story, so this says what kind of news it is and what changed. */
export function storyUpdate(story: NewsStory, zone: string | null): string {
  return [`↻ **${plain(oneLine(story.status))}**`, ...paragraphs(story.change ?? story.summary).map(plain), footer(story, zone)].join("\n\n");
}

function count(stories: number, inRussian: boolean): string {
  if (!inRussian) return stories === 1 ? "1 story" : `${stories} stories`;
  const few = (2 <= stories % 10 && stories % 10 <= 4) && !(12 <= stories % 100 && stories % 100 <= 14);
  return `${stories} ${stories % 10 === 1 && stories % 100 !== 11 ? "история" : few ? "истории" : "историй"}`;
}

/** The edition's lead stories in full, then the rest under their sections in the order the editor ranked them. */
function arrange(selection: EditionSelection, stories: NewsStory[]) {
  const top = Math.min(selection.top ?? LEAD_STORIES, stories.length), sections = new Map<string, Array<{ number: number; story: NewsStory }>>();
  stories.slice(top).forEach((story, index) => {
    const name = oneLine(story.section);
    sections.set(name, [...sections.get(name) ?? [], { number: top + index + 1, story }]);
  });
  return { lead: stories.slice(0, top), sections: [...sections] };
}

/** The morning edition, once as a rich message and once as ordinary text for a Telegram that refuses the first. */
export function editionPost(selection: EditionSelection, stories: NewsStory[], name: string, zone: string | null): { html: string; text: string } {
  const inRussian = stories.some(story => russian(story.title));
  const day = new Intl.DateTimeFormat(locale(inRussian), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(selection.edition + "T12:00:00Z"));
  const heading = `${oneLine(selection.title ?? name)} · ${day}`, lead = inRussian ? "Главное" : "Top stories";
  const end = inRussian ? `Это всё на сегодня · ${count(stories.length, true)}` : `That is all for today · ${count(stories.length, false)}`;
  const arranged = arrange(selection, stories);
  const anchors = (story: NewsStory) => links(story).map(source => `<a href="${attribute(source.url)}">${html(label(source))}</a>`).join(" · ");
  const account = (story: NewsStory, whole: boolean, view = true) => [
    ...(whole ? paragraphs(story.summary) : paragraphs(story.summary).slice(0, 1)).map(paragraph => `<p>${html(paragraph)}</p>`),
    story.view && view ? `<p>→ ${html(oneLine(story.view))}</p>` : "", `<p>${anchors(story)}</p>`].join("");
  // A lead story is its headline, what happened and why it matters: two minutes for the five of them. Every other story is one line
  // that opens to its whole account. A long day first shortens what those lines open to, then lists them with their links alone.
  const rich = (detail: number) => [
    `<h1>${html(heading)}</h1>`, selection.intro ? paragraphs(selection.intro).map(paragraph => `<p>${html(paragraph)}</p>`).join("") : "",
    `<h2>${lead}</h2>`,
    ...arranged.lead.map((story, index) => `<h3>${index + 1}. ${html(oneLine(story.title))}</h3>${account(story, false)}`),
    ...arranged.sections.flatMap(([section, items]) => [`<h2>${html(section)}</h2>`, ...items.map(({ number, story }) => detail < 2
      ? `<details><summary>${number}. ${html(oneLine(story.title))}</summary>${account(story, detail === 0, detail === 0)}</details>`
      : `<p>${number}. ${html(oneLine(story.title))} · ${anchors(story)}</p>`)]),
    `<footer>${html(end)}</footer>`].join("");
  const fitted = [0, 1, 2].map(rich).find(message => message.length <= EDITION_CHARACTERS) ?? rich(2);
  const text = [
    `**${plain(heading)}**`, ...selection.intro ? paragraphs(selection.intro).map(plain) : [],
    `**${lead}**`,
    ...arranged.lead.flatMap((story, index) => [`**${index + 1}\\. ${plain(oneLine(story.title))}**`, ...paragraphs(story.summary).slice(0, 1).map(plain),
      ...story.view ? [`→ ${plain(oneLine(story.view))}`] : [], footer({ ...story, eventAt: null }, zone)]),
    ...arranged.sections.flatMap(([section, items]) => [`**${plain(section)}**`,
      ...items.map(({ number, story }) => `${number}\\. ${plain(oneLine(story.title))} · ${footer({ ...story, eventAt: null }, zone)}`)]),
    `_${plain(end)}_`].join("\n\n");
  return { html: fitted, text };
}

export interface NewsDesk { store: Store; telegram?: TelegramAdapter; conversationId: string; chatId: string | null }
export type NewsDelivery = { sent: true; kind: "alert" | "card" | "update" | "edition"; telegramMessageId: string | null }
  | { sent: false; reason: string; already?: string; sameSourceAs?: string };

/** The desk's chat when Telegram can take a post now; otherwise why not, in words the editor can act on. */
function destination(desk: NewsDesk): { chatId: string } | { reason: string } {
  if (!desk.chatId) return { reason: "This desk has no Telegram chat: its schedules deliver to the app." };
  if (!desk.telegram?.enabled()) return { reason: "Telegram is not connected on this Home." };
  if (desk.store.getSetting("telegram.paused." + desk.chatId) === "true") return { reason: "The owner paused this Telegram chat." };
  return { chatId: desk.chatId };
}

type Receipt = { sent: boolean; status: string; telegramMessageIds: string[]; error?: string };
const outcome = (receipt: Receipt, kind: "alert" | "card" | "update" | "edition"): NewsDelivery => receipt.sent
  ? { sent: true, kind, telegramMessageId: receipt.telegramMessageIds[0] ?? null }
  : { sent: false, reason: receipt.status === "not_sent" ? `Telegram refused the post: ${receipt.error ?? "no reason given"}. It was not sent.`
    : "Telegram did not confirm the post. Do not publish it again; the owner is told to check the chat." };

/** Sound is for the day's first must-know stories, in the owner's daytime. */
function loud(desk: NewsDesk, chatId: string, zone: string | null, now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone ?? "UTC", hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour < 8 || hour >= 22) return false;
  const today = localDate(now, zone), sent = telegramTimes(desk.store, desk.conversationId, chatId);
  const alerts = new Set((desk.store.db.prepare("SELECT story_id AS id FROM messages WHERE conversation_id=? AND story_json IS NOT NULL AND hidden=0 AND json_extract(story_json,'$.telegram')='alert' AND created_at>=?")
    .all(desk.conversationId, new Date(now.getTime() - 2 * 86_400_000).toISOString()) as Array<{ id: string }>).map(row => row.id));
  return [...sent].filter(([story, at]) => alerts.has(story) && localDate(new Date(at), zone) === today).length < ALERTS_A_DAY;
}

/** Another story whose first source is the same page and which already went out this week: the same event under a second name. */
function sameSource(desk: NewsDesk, chatId: string, story: NewsStory, now: Date): string | null {
  const first = page(story.sources[0]!.url), since = now.getTime() - SAME_SOURCE_DAYS * 86_400_000;
  const sent = new Map([...telegramTimes(desk.store, desk.conversationId, chatId)].filter(([id, at]) => id !== story.id && Date.parse(at) >= since));
  if (!first || !sent.size) return null;
  const rows = desk.store.db.prepare("SELECT story_id AS id, json_extract(story_json,'$.sources[0].url') AS url FROM messages WHERE conversation_id=? AND story_json IS NOT NULL AND hidden=0 AND created_at>=?")
    .all(desk.conversationId, new Date(since - 86_400_000).toISOString()) as Array<{ id: string; url: string | null }>;
  return rows.find(row => sent.has(row.id) && row.url && page(row.url) === first)?.id ?? null;
}

/** Sends the published version of a story as the editor asked: its first post, or a reply under it for a development. Null when
 * the version stays in the app. Never throws for a refused or unreachable Telegram: the story is published either way. */
export async function deliverStory(desk: NewsDesk, messageId: string, now = new Date()): Promise<NewsDelivery | null> {
  const message = desk.store.getMessage(desk.conversationId, messageId), story = message?.story;
  if (!message || !story?.telegram) return null;
  const target = destination(desk);
  if ("reason" in target) return { sent: false, reason: target.reason };
  const { chatId } = target, zone = ownerTimezone(desk.store);
  const first = desk.store.findMessageByExternal("telegram", storyPost(chatId, desk.conversationId, story.id));
  try {
    if (!first) {
      const same = sameSource(desk, chatId, story, now);
      if (same) return { sent: false, sameSourceAs: same, reason: `Story ${same} with the same first source went out this week. Publish a development under that storyId, with change, instead.` };
      const alert = story.telegram === "alert" && loud(desk, chatId, zone, now);
      return outcome(await desk.telegram!.sendToChat({ chatId, text: storyCard(story, zone), files: [], externalId: storyPost(chatId, desk.conversationId, story.id),
        silent: !alert, preview: story.sources[0]!.url }), alert ? "alert" : "card");
    }
    const parts = desk.store.db.prepare("SELECT status, message_id AS id FROM telegram_outbox WHERE key>=? AND key<? ORDER BY key")
      .all(`${chatId}:reply:${first.id}:`, `${chatId}:reply:${first.id}:￿`) as Array<{ status: string; id: string | null }>;
    const card = parts.find(part => part.status === "delivered");
    if (first.status !== "completed" || !card) return { sent: false, reason: first.status === "running" || parts.some(part => ["pending", "sending", "unknown"].includes(part.status))
      ? "Telegram did not confirm this story's first post. Nothing more is sent under it; the owner is told to check the chat."
      : "Telegram refused this story's post, so it is not in the chat. The edition can still carry the story." };
    if (!story.change) return { sent: false, already: first.createdAt, reason: "This story is already in Telegram. Only a development, with change, is sent again, as a reply." };
    const version = String(message.externalId ?? "").split(":").at(-1)!;
    return outcome(await desk.telegram!.sendToChat({ chatId, text: storyUpdate(story, zone), files: [], externalId: storyPost(chatId, desk.conversationId, story.id, version),
      silent: true, replyTo: Number(card.id) }), "update");
  } catch (error) { return { sent: false, reason: error instanceof Error ? error.message : String(error) }; }
}

/** Sends today's edition once. A revised selection for the same date changes the app and sends nothing again. */
export async function deliverEdition(desk: NewsDesk, name: string, now = new Date()): Promise<NewsDelivery | null> {
  const selection = savedEdition(desk.store, desk.conversationId);
  if (!selection) return null;
  const target = destination(desk);
  if ("reason" in target) return { sent: false, reason: target.reason };
  const { chatId } = target, zone = ownerTimezone(desk.store);
  if (selection.edition !== localDate(now, zone)) return { sent: false, reason: "Only today's edition goes to Telegram." };
  const externalId = `${chatId}:news-edition:${desk.conversationId}:${selection.edition}`;
  const previous = desk.store.findMessageByExternal("telegram", externalId);
  if (previous) return { sent: false, already: previous.createdAt, reason: "Today's edition is already in Telegram. The app shows the new selection." };
  const latest = new Map(latestStories(desk.store, desk.conversationId).map(message => [message.story.id, message.story]));
  const post = editionPost(selection, selection.storyIds.flatMap(id => latest.get(id) ?? []), name, zone);
  try { return outcome(await desk.telegram!.sendToChat({ chatId, text: post.text, rich: post.html, files: [], externalId }), "edition"); }
  catch (error) { return { sent: false, reason: error instanceof Error ? error.message : String(error) }; }
}
