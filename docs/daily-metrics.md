# Выдох · Telegram Mini App

Four daily scores: calm, focus, energy and mood. New entries use 1–10; higher means better. The main screen shows four separate weekly averages, answer counts and changes from the previous week. Select a participant, then a metric card to see its dated chart. Navigate five Monday–Sunday weeks; the current week is explicitly unfinished. The API returns these weeks plus a complete comparison week, aligned to Monday, rather than a truncated rolling window. Each comparison shows both weeks' answer counts and uses only actual answers. A gap means no answer. The archived bustle series is projected once as `calm = 10 − bustle`; historical zero stays zero. Other metrics are never invented for earlier dates.

The collapsible **Мой день** form always belongs to the signed-in viewer, including while viewing somebody else's history. The day table and calculation notes are disclosures; no combined index is calculated. Refresh reloads the signed API, retains unsaved inputs and labels retained data when a request fails. A changed local date resets the draft. Theme and all four safe-area edges follow Telegram events. No participant IDs, scores or initialization data are persisted in browser storage or bundled into the assets.

Telegram signs the identity. Only people in the owner-installed `dailyMetrics.config` can read the shared journal, and each person can save only their own four scores for today in the configured timezone. The app does not grant Home administration or access to other conversations. Telegram initialization data expires after 24 hours and is never stored by the app.

The WAI daily-metrics calendar excludes Saturdays. The API projection and chart omit them;
original votes remain in the journal, but new app writes on a Saturday are rejected.
The Mini App and the text summary count calm marks on eligible dates only: Friday to
Sunday is consecutive, historical zero counts, and a missing ordinary date breaks the
series. Today without an answer does not break it. A series reaching the API's oldest
date is marked as a lower bound with `+`. This policy is specific to daily metrics; the generic check-in API for other
poll schedules keeps its existing calendar behavior. The rendered morning-card layout
and its independent streak calculation are not changed by this patch.

Scores from the app use closed, non-delivered poll records in the existing journal. Actual Telegram votes are retained. The newest answer for a person, date and metric wins. The separate morning image uses this normalized journal through its existing renderer and schedule. Its layout, streak algorithm, caption and delivery configuration are outside this UI change.

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

`npm test -- tests/daily-metrics.test.ts tests/check-ins.test.ts tests/web-routes.test.ts tests/daily-metrics-card.test.ts` covers signed identity, expiry, tampering, access boundaries, original votes, legacy zero, missing dates, duplicate dates, atomic own-day writes, complete calendar windows, scoped HTTP routes and the unchanged morning-card delivery. Run `npm run typecheck` as well.

`node --test tests/daily-metrics-calendar.node.mjs` on Node 24 runs the dependency-free
Saturday regressions against the real browser functions and server calendar helper.
It also covers week boundaries, per-metric sample sizes and means, and the comparison-window limit.

For browser integration tests:

```bash
npm ci --ignore-scripts
npx playwright install chromium          # install browser dependencies if the host lacks them
npm run test:metrics-ui                  # builds the runtime, then runs Chromium
```

The Playwright fixture starts an isolated in-memory `Store` and the real `HttpApi` on
loopback for each test. Its fake Telegram SDK supplies correctly signed fixture identities;
requests use the real HMAC, allowlist and journal. It checks both participants, own writes while
viewing another participant, save/reload, network retry, draft retention, unauthenticated/expired/
forged/foreign access, Saturdays, historical zero, week navigation, 320/390/1024px layouts,
Telegram theme/safe-area events and browser errors. Screenshots of **fictional** participants
are saved under `.data/metrics-ui-results/`; no real journal is accessed. Loading/retry faults
are deliberately injected in the browser; successful GET/POST requests are not mocked.

These local checks do not verify a production deployment or a real Telegram webview. After the
normal release, check the actual HTTPS route and both configured identities inside Telegram.
The renderer of the separate morning image and the generic check-in API retain their existing
calendar calculations; this UI change does not claim to update those surfaces.
