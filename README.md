# OpenStrudel

OpenStrudel is a team of AI employees on your own devices. Each employee runs on one Mac or server, where its conversations, files and accounts stay. The native app opens local employees and employees from several connected devices together. There is no primary device.

The independent-device redesign is in local acceptance, not yet in the downloadable release. See [the device model and acceptance results](docs/device-first-review.md). The [older primary-device protocol](docs/primary-home.md) remains supported for existing installations.

This repository contains the public source. Local credentials, chat histories and personal migration scripts are excluded. Downloads and current iOS availability are listed at [waiwai.is/openstrudel](https://waiwai.is/openstrudel).

The product has three concepts: devices, employees, and conversations. Each device runs the same Home runtime. Codex owns the work and its thread history. OpenStrudel keeps channel bindings, messages and delivery receipts, employee instructions, connection state and the clock for recurring requests. There is no task dashboard or second agent loop.

## Start on this Mac

Open the app, start on the current Mac and sign in to OpenAI. Create an employee by describing its job, or restore employees from a backup. Personal/work classification and appearance are not required during creation. Appearance and instructions can be edited later.

To add another device, open **Settings → Devices → Get connection link** on that device. Paste the link in **Connect device** on your laptop and confirm the device shown. The app confirms the connection before opening its employees. When creating an employee, choose where it will run; the current Mac is the default. An unavailable device does not block other devices.

**Settings → Accounts** shows the selected device's OpenAI accounts, remaining usage windows, reset times and separate credit balance. **Settings → Backups** saves that device's employees, conversations, files and schedules in one `.openstrudel` file, optionally protected by a password. Account and service credentials are excluded. Restore previews the contents and adds employees without replacing existing ones; restored schedules start paused. Removing a device connection leaves its employees and history on the device.

## Optional servers

The native Mac app can run Home on your Mac. For access away from the Mac or while it is asleep, cloud setup on Mac supports your own DigitalOcean account. Review the current price and confirm before a server is created. You pay DigitalOcean directly; OpenStrudel adds no hosting charge. iOS connects to an existing Home by invitation and does not offer hosting signup or payment.

The optional hosting service imported from WAI VDS is in `services/hosting`. Its own account and billing are separate from Home and Codex. The new purchase path remains disabled in public builds pending real infrastructure acceptance.

The cloud plan uses 2 vCPU and 4 GB RAM in Frankfurt, with Amsterdam as the same-plan fallback. Installation retries are bounded and reuse the same server and data volume. If setup is interrupted, reopen the app to check the existing installation rather than create another one. The app checks the server's generated identity before sending the owner credential.

To stop hosting charges, delete the server in DigitalOcean after saving any data you need. Closing the app or powering off the server does not end billing.

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

“New employee” opens a chat immediately. Tell it its name, role and permanent rules in conversation, or edit those rules in its profile. A real Codex tool saves the character and displays a receipt.

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

On another Mac or iPhone, scan the code or paste the link from **Settings → Devices → Get connection link** on the device running your employees. Confirm that device. This connects to its existing employees, history, Telegram and schedules; iOS does not run another Home.

For access from another network, configure a reachable public address or a private network between your devices. Home uses its configured public address in new links by default. A Mac without either still needs the same local network. OpenStrudel does not provision a relay automatically or require a vendor-operated relay.

An operator can use the restricted SSH relay scripts with their own server. The server forwards encrypted TCP to the Mac's HTTPS listener; TLS terminates on the Mac. Save the reachable address in the Home data directory's `.env` (`~/Library/Application Support/OpenStrudel/runtime/.env` for the native Mac app):

```dotenv
OPENSTRUDEL_PUBLIC_HOST=your-server.example.com
OPENSTRUDEL_PUBLIC_PORT=17789
```

These settings survive app updates. Legacy public-address and TLS-path settings in the installed Mac LaunchAgent are also retained. The relay's client and server both check for lost connections, so a disconnected session releases the public port for reconnection. The Mac and relay must stay online. [Remote access validation](docs/releases/2026-10-09-remote-access.md).

The link is single-use and expires after five minutes. Anyone holding an unused link can connect with the access it grants. The client checks the Mac's TLS identity against the fingerprint in the link, then keeps its own credential in Keychain. Settings can revoke each connected device. The existing HTTP API stays on localhost; paired devices use a separate HTTPS listener on port 7789. Employees and their data remain on the device where they run.

## Verify

```bash
npm run typecheck
npm test
npm run build
```
