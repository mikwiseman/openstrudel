# Exhale · Telegram Mini App

Four daily scores: calm, focus, energy and mood. New entries use 1–10; higher means better. The app shows each participant's day, a 7/30-day trend and a dated table. A gap means no answer. The archived bustle series is projected once as `calm = 10 − bustle`; historical zero stays zero. Other metrics are never invented for earlier dates.

Telegram signs the identity. Only people in the owner-installed `dailyMetrics.config` can read the shared journal, and each person can save only their own four scores for today in the configured timezone. The app does not grant Home administration or access to other conversations. A Home administrator can ask the assistant in chat to record a participant's four scores for today or for a missed day within the last 30 days (`record_daily_scores`). The assistant records only numbers the person gave. These entries go to the same journal, and the Mini App and the morning graphic show them. Telegram initialization data expires after 24 hours and is never stored by the app.

Scores from the app use closed, non-delivered poll records in the existing journal. Actual Telegram votes are retained. The newest answer for a person, date and metric wins. The selected morning schedule renders directly from this normalized journal: four separate trend lines for each participant on the same 0–10 scale, exact dated scores, and changes from each metric's previous recorded rating. Every change names its actual baseline date, even when it falls outside the chart. A missing latest rating has no change; a first rating has no invented baseline.

The chart shows seven check-in days, Sunday–Friday, with English weekdays above dates in every participant's section. Saturday is excluded from charts, changes and calm check-in streaks. Missing reporting days break lines; zero remains a real rating and calm is never inverted again. The caption contains only the English heading, weekday and date, with no AI footer. Sunday mornings stay quiet because Saturday is excluded; the separate weekly review is not repeated in Monday images. Rendering uses no model call and delivery uses the existing durable Telegram receipt and app button.

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

Use the existing bot's `setChatMenuButton` with `type: web_app`, `text: Exhale`, and the public HTTPS URL ending in `/check-in/`. Set it for the configured participants' private chats. Read it back with `getChatMenuButton`. No chat message is required.

For groups, enable the same URL as the bot's Main Mini App in BotFather and verify `getMe.has_main_web_app`. The group menu and daily graphic use a normal URL button to `https://t.me/<bot_username>?startapp=checkin`; Telegram's `web_app` button is private-chat-only. Pin the group menu without removing existing pins. Set `summaryScheduleId` only after this link works; the selected schedule must belong to the configured conversation and timezone and deliver to its exact group. All other schedules retain their existing behavior.

Before replacing the Home image: wait for active work to finish, preserve a consistent rollback snapshot, and keep the paired TLS identity and review deployment unchanged. Validate the proxy before reloading. Check the public assets, unauthenticated rejection, both identities, database integrity, the existing review route, and an actual Telegram launch after the update.

## Verification

`npm test -- tests/daily-metrics.test.ts tests/check-ins.test.ts tests/web-routes.test.ts` covers signed identity, expiry, tampering, access boundaries, original votes, legacy zero, missing dates, duplicate dates, atomic own-day writes, and scoped HTTP routes. `tests/daily-metrics-card.test.ts` also checks exact report dates, missing answers, separate trends, dated positive/negative/zero changes, Saturday exclusions and one captioned photo with a launch button through scheduler recovery. Render the app at narrow phone and desktop widths; exercise save/reopen, both people, all metrics, periods, dark mode, and errors. Use disposable fixture data for writes, never synthetic production scores.
