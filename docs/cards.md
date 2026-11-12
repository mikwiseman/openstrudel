# Cards: what waits for a person

A card is one thing that waits for one person, with its action on it. The main assistant or an employee raises it with one tool, `raise_card`; the Home raises one itself when a connected service asks to send words. In Telegram a card is one message with buttons, in the chat of the person who can answer. The same cards are one list for the app.

## The five kinds

| Kind | What it shows | Buttons | What a press does |
|---|---|---|---|
| `send` | Who receives the words, through what, the subject and the whole text | Send, Keep as draft | Through this Home's bot the Home sends that exact text itself, with no model turn. Through another service the raiser is told to send exactly that text. A draft closes the card and nothing leaves. |
| `answer` | A question, one line on why now | Two or three choices from the raiser, then Something else | The answer goes to the conversation that asked, as the person's own reply. |
| `due` | A promise or deadline and its date | Done, New date | Done closes it with no model turn. A new date is given in words. |
| `connect` | An access that is missing | Open (a link), Done | Done tells the raiser to check the access and carry on. |
| `failed` | A promised message that did not come, and the next try | Got it | Closes it. |

Words are always an answer too: a reply to the card's message. "Something else" and "New date" only say so.

## Where a card goes and who may answer

- With `person` (a name or Telegram id of someone with access to this Home): that person's own chat with the bot. Only they can answer.
- Otherwise: where the turn's answer goes. That is the Telegram chat of the request, a schedule's delivery chat, or the chat bound to the conversation. In a private chat the card is for its person. In a group it is for anyone with access to this Home who may write in that group.
- With no Telegram chat the card lives in the app only.

A press is accepted only from a verified Telegram sender the card is for, in the chat and on the message the card was shown in, with access to this Home at that moment. Anyone else gets a short notice and nothing changes. A card takes one answer: the first, from Telegram or the app. The message is then edited to say what was decided and by whom, and its buttons go.

A card that nobody answered stays open and is never shown again: raising the same thing twice returns the waiting card. When the thing is done elsewhere or out of date, the raiser closes its own card with `close_card` and one short reason, which the card's message then shows. A conversation may have twelve cards waiting at most. A turn that raises a card into the chat it is answering and ends with `NO_REPLY` sends nothing else. A scheduled run's cards for its own chat are shown right after its report, so the chat reads in order; a quiet run's cards are shown when it ends. Each turn is told about its own cards: the ones still waiting, and answers it has not seen.

Cards are not shown in a chat with restricted access, are not offered to a sender without access, and are not offered to a run that reads the owner's private correspondence.

A chat whose Codex thread began before this tool existed gets `raise_card` and `close_card` through the per-turn tool bridge, like the management tools.

## A send shows exactly what leaves

The text on a send card is shown as written, never read as formatting, and the Home's own bot sends it the same way. A card too long for one Telegram message has no buttons there: the whole of it waits in the app.

When a connected service asks to send (a sending verb in the tool's name, a recipient and a text among its arguments), the approval reads as the same send card: recipient, subject, the whole text, and every other argument as a plain fact. Nothing the action will do is hidden. Other approvals look as before.

A press on Send is the approval of one call:

- While the service is still waiting, the press lets that call run.
- After the wait ran out, or after a restart, the card is still there. A press starts the action again, and the one call with exactly the same arguments (or, for a card the assistant raised, a call that carries exactly the shown text) runs without a second question. Any other call asks again with its own card.

## For the app

- `GET /v1/cards` returns `{ open, recent }`: what waits, longest first, and what was decided in the last 24 hours. Each card has `id`, `kind`, `state`, `createdAt`, `raiser {profileId, name}`, `conversationId`, `messageId`, `title` (60 characters at most), `reason`, `content` (`to`, `via`, `subject`, `text`, `details`, `due`, `url`, `nextTry`, whichever apply), `choices [{id, label, role, needsText?, url?}]`, `chat {id, title}`, `for [{id, name}]` (null: anyone with access), `canAnswer` and `answer {choice, label, text, by, via, at, outcome}`, where `via` is `telegram`, `app` or `raiser`.
- `POST /v1/cards/{id}/answer` takes `{choice}`, `{choice, text}` or `{text}`. It answers `200 {card}`, `409` with the card when it was already decided, `400` for an answer the card does not offer, `404` for an unknown card. For a send raised by the assistant, `text` with `choice: "send"` is the text as the person edited it, and that text is what leaves.
- Both routes are for owner devices. A card for one named person who is not an owner of this Home has `canAnswer: false`.

Checked by `tests/cards.test.ts` and `tests/interactions.test.ts`.
