# OpenStrudel

OpenStrudel is a minimal personal AI Home: a Grok Bots style set of named employees with Codex underneath. One Home can be reached from the native Mac app, iOS app, Telegram, or the optional browser fallback.

This repository contains the current development source. DigitalOcean onboarding is still being validated; this snapshot is not a new production release. Local credentials, chat histories and personal migration scripts are excluded.

The product has three concepts: one Home process, named employees, and conversations. Codex owns the work and its thread history. OpenStrudel keeps channel bindings, messages and delivery receipts, employee instructions, connection state and the clock for recurring requests. There is no task dashboard or second agent loop.

## Run locally

```bash
npm install
npm run build

# Start Home using the Codex subscription already signed in on this machine
npm start

# Or use an offline mock server
OPENSTRUDEL_CODEX_MODE=mock OPENSTRUDEL_DB=:memory: npm start

# In another terminal, send through the running Home
node dist/cli.js message "Привет"
```

Home listens on `127.0.0.1:7788`. Set `OPENSTRUDEL_API_TOKEN` to require a bearer token. The database defaults to `.data/openstrudel.sqlite` and uses SQLite WAL. Native clients keep transport details out of the chat surface.

The checked-in Codex default is `gpt-6-astra`; set `OPENSTRUDEL_CODEX_MODEL` to another model available in your installed Codex CLI. Set `OPENSTRUDEL_CODEX_MODE=mock` for an offline run. Codex is the only execution engine.

## Channels and employees

- `POST /v1/messages` sends a message to the main chat or to an employee.
- `GET/POST /v1/profiles` lists or creates named employees.
- `GET /v1/conversation` loads the main chat.
- `GET /v1/agents/<id>/conversation` loads an employee chat.
- `GET /health` and `GET /v1/integrations` provide connection status.

“New bot” opens a chat immediately. Tell it its name, role and permanent rules in conversation, or edit those rules in its profile. A real Codex tool saves the character and displays a receipt.

A Telegram chat can be pinned to an employee in that employee's settings, or with `/bind Full Name`. Messages then go to that employee without a prefix. An explicit `@Name` addresses another employee without changing that default. Private bot messages share the employee's native conversation when it is not already assigned to another Telegram chat; additional groups keep separate histories. The employee header's menu switches between them. Unbound messages without a name go to the main assistant. Replying to a delivered digest returns to its original employee even if the Telegram chat is now pinned to someone else.

Native clients use `POST /v1/messages?async=true` with an `externalId` UUID. Accepted messages survive closing the view; duplicates do not execute twice. An interrupted turn is marked failed on restart and never replayed automatically.

Use the composer’s plus button for Codex apps and configured MCP services, or ask an employee to connect Gmail. Complete the provider's sign-in, then press Continue. OpenStrudel checks actual callable status. Approvals and connection cards also work inside Telegram. Computer tools retain their own per-application permissions; discovery alone does not grant screen access.

The engine uses the official local [Codex App Server](https://developers.openai.com/codex/app-server), pinned to the installed CLI protocol. See [ARCHITECTURE.md](ARCHITECTURE.md) for the migration and supported approval flows.

## Telegram

Set `TELEGRAM_BOT_TOKEN`, or connect a bot from the native app's Settings screen. OpenStrudel verifies the token, creates a short-lived link code, and accepts messages only from linked chats. Send `/start CODE` to the bot once; after that, write normally.

In groups, the sender must also be paired. Incoming updates are recorded before the poll offset advances; outgoing chunks keep Telegram's message receipts. Explicit rate limits are retried after Telegram's specified delay. An ambiguous network result is not blindly resent.

Voice messages and audio files up to 20 MB are transcribed on the machine running Home. On macOS, install OpenRamble and its model; the runtime finds `~/.local/bin/openramble` or the CLI inside `/Applications/OpenRamble.app`. The Linux Docker image includes whisper.cpp and the multilingual large-v3-turbo Q5 model, with no transcription API key or separate service. A real offline test with 2 CPU / 2 GB took about one minute for a 26-second Russian recording; this path is not instant. Linux recordings are limited to five minutes. Temporary audio is removed after transcription. The iPhone client does not supply the transcription engine. Raspberry Pi performance has not been measured.

## Recurring requests and history

Ask an employee in chat to prepare something at a time, with a timezone. Codex saves it through a real schedule tool. The employee's settings show the schedule and a pause switch. The clock uses five-field cron and IANA timezones; it sends the request through the same per-conversation queue as an ordinary message. Results appear in the conversation and, when configured, the connected Telegram chat.

Home must be running and online. After sleep, only the latest missed edition runs. Interrupted actions and uncertain deliveries are recorded for review instead of replayed. An unattended edition cannot wait indefinitely for a new connector sign-in or interactive approval.

Historical messages can be imported through `POST /v1/conversations/<id>/history` with stable external IDs, dates and authors. Import is idempotent and never executes old messages. Codex searches a private JSONL archive when it needs earlier context, instead of sending the whole archive in every prompt. Native clients load history in pages. Attachments stay in the source Telegram chat; only text and captions are imported.

Native replies use Foundation Markdown with SF Pro body text, New York headings and SF Mono code. Tables become labeled rows on iPhone and remain scrollable tables on Mac. Nested lists, quotations, links and emphasis retain their structure. Telegram uses native message entities and converts tables to readable labeled blocks. Native clients follow system appearance and Dynamic Type, keep drafts across relaunches, and preserve the reading position when replies arrive.

## Install Home

```bash
scripts/install-local.sh
```

The script checks Node 22+, builds the runtime, creates a private `.data` directory, and installs a macOS LaunchAgent or Linux user service. The same Home runs on a Mac mini or Raspberry Pi.

On macOS, install the native app with `scripts/install-mac-app.sh`. The SwiftUI project in `native/OpenStrudel` builds the Mac and iOS clients with the Liquid Glass interface.

On iPhone, open the app and scan the code from **Mac Settings → Подключить iPhone**. A shared connection link also works. Confirm the Mac shown on the phone. Both devices must be on the same Wi-Fi network, with Home running on the awake Mac. This connects to the existing employees, history, Telegram and schedules; it does not create another Home. Access away from that network is not supported by this connection.

The code is single-use and expires after five minutes. The phone checks the Mac's certificate against the fingerprint in the code, then keeps its credential in Keychain. Mac Settings can revoke mobile access. The existing HTTP API stays on localhost; paired phones use a separate HTTPS listener on port 7789.

## Verify

```bash
npm run typecheck
npm test
npm run build
```
