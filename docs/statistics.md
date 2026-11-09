# Usage statistics

A request is one executed turn: a message from the app or Telegram, a scheduled run, or an event that a connected source delivered (correspondence, the owner's pipelines). A steer that joined a running turn, imported history and context-only messages are not requests.

Every turn records the provider, model, speed and reasoning that served it, and the tokens and cost its engine reported, in `turn_usage`. Cost is at the providers' API prices. A model or speed without a published price has no cost, and the app says so. Tokens and cost exist from the day a Home first ran this build.

## Home API (owner only)

- `GET /v1/statistics` serves thirty local days and twelve weeks from Monday in the owner's timezone: requests by source and outcome, tokens, cost, and the chats, schedules and models behind them. The unfinished day and week carry the previous ones up to the same moment for a fair comparison.
- `GET /v1/schedules` lists every recurring schedule with its chat and this week's runs, failures, tokens and cost. Settings → «Расписания» switches a schedule through its chat's own save, `POST /v1/conversations/<id>/schedules`, which keeps its poll, delivery and backup.

## The morning card

Each morning the Home draws a card about yesterday: requests, the day before for comparison, the last seven days as bars, tokens, cost, failures, where requests came from, and one line with a little character. On Sunday the card adds the seven days that ended yesterday. The clock draws it from the same numbers as `GET /v1/statistics`, and no model writes it.

To turn it on, create a schedule in the owner's private chat with the bot that delivers to that chat, for example `0 9 * * *` in the owner's timezone. Then set the Home setting `statistics.cardScheduleId` to that schedule's id. The card names every chat and its cost, so it goes only to a paired owner's private chat, or stays in the app when the schedule has no Telegram delivery. Pointed at any other chat, the run fails without sending anything. Switch it off in Settings → «Расписания».
