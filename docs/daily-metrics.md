# Выдох · Telegram Mini App

Four daily scores: calm, focus, energy and mood. New entries use 1–10; higher means better. The app shows each participant's day, a 7/30-day trend and a dated table. A gap means no answer. The archived bustle series is projected once as `calm = 10 − bustle`; historical zero stays zero. Other metrics are never invented for earlier dates.

Telegram signs the identity. Only people in the owner-installed `dailyMetrics.config` can read the shared journal, and each person can save only their own four scores for today in the configured timezone. The app does not grant Home administration or access to other conversations. Telegram initialization data expires after 24 hours and is never stored by the app.

Scores from the app use closed, non-delivered poll records in the existing journal. Actual Telegram votes are retained. The newest answer for a person, date and metric wins. Version 1.1.1 renders the selected morning schedule directly from this normalized journal: a seven-day map of all four metrics for each participant, emphasized latest scores, streaks and an app button. The date columns always represent seven calendar days, including absent dates. Missing answers remain gaps; calm is never inverted again. Monday images retain per-metric weekly averages, changes from the previous week and the calmest day. The caption contains only the date and AI attribution. Rendering uses no model call and delivery uses the existing durable Telegram receipt.

## Deployment

The owner installs this setting in the Home database; real IDs and credentials stay outside Git:

```json
{
  "conversationId": "configured-conversation-id",
  "chatId": "-1000000000000",
  "timezone": "Europe/Moscow",
  "publicOrigin": "https://your-domain.example",
  "participants": [{"id": "123456789", "name": "Person"}],
  "metrics": {
    "calm": "calm-schedule-id",
    "focus": "focus-schedule-id",
    "energy": "energy-schedule-id",
    "mood": "mood-schedule-id"
  },
  "legacyCalmScheduleId": "optional-disabled-bustle-schedule-id",
  "summaryScheduleId": "existing-morning-schedule-id"
}
```

Set `OPENSTRUDEL_METRICS_PORT=7790` for the optional private HTTP listener. It serves only `/check-in/`, its assets, and `/check-in/api`. Do not publish that port on the host. Place the Home and HTTPS proxy on a private Docker network, then add an exact route while retaining other routes:

```caddyfile
redir /check-in /check-in/ 308
handle /check-in/* {
  reverse_proxy openstrudel-home-1:7790
}
```

Use the existing bot's `setChatMenuButton` with `type: web_app`, `text: Выдох`, and the public HTTPS URL ending in `/check-in/`. Set it for the configured participants' private chats. Read it back with `getChatMenuButton`. No chat message is required.

For groups, enable the same URL as the bot's Main Mini App in BotFather and verify `getMe.has_main_web_app`. The group menu and daily graphic use a normal URL button to `https://t.me/<bot_username>?startapp=checkin`; Telegram's `web_app` button is private-chat-only. Pin the group menu without removing existing pins. Set `summaryScheduleId` only after this link works; the selected schedule must belong to the configured conversation and timezone and deliver to its exact group. All other schedules retain their existing behavior.

Before replacing the Home image: wait for active work to finish, preserve a consistent rollback snapshot, and keep the paired TLS identity and review deployment unchanged. Validate the proxy before reloading. Check the public assets, unauthenticated rejection, both identities, database integrity, the existing review route, and an actual Telegram launch after the update.

## Verification

`npm test -- tests/daily-metrics.test.ts tests/check-ins.test.ts tests/web-routes.test.ts` covers signed identity, expiry, tampering, access boundaries, original votes, legacy zero, missing dates, duplicate dates, atomic own-day writes, and scoped HTTP routes. `tests/daily-metrics-card.test.ts` also checks exact report dates, missing answers, weekly math and one captioned photo with a launch button through scheduler recovery. Render the app at narrow phone and desktop widths; exercise save/reopen, both people, all metrics, periods, dark mode, and errors. Use disposable fixture data for writes, never synthetic production scores.
