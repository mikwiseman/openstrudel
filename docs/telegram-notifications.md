# External Telegram notifications

`POST /hooks/telegram` relays prepared text through the Home's existing Telegram
connection. It does not invoke an AI engine. The route is available on the local
HTTP listener and the remote HTTPS listener.

An operator enables it with the `telegram.notification_hook` setting:

```json
{"chatIds":["<connected destination>","<another connected destination>"],"tokenHash":"<SHA-256 hex of a dedicated random token>"}
```

`chatIds` is a list of 1 to 10 distinct destinations. The Home still accepts the
earlier form with a single `"chatId":"<connected destination>"`. If the setting
has both fields, the Home uses `chatIds` and ignores `chatId`, so one setting can
also serve a Home that reads only `chatId`. When Telegram upgrades a group to a
supergroup, the Home replaces the group's ID in both fields.

Keep the token with the sending service, separate from the Home owner token.
Requests need `Authorization: Bearer <token>`, a stable `Idempotency-Key` (up to
200 letters, digits, dots, underscores, colons or hyphens), and a JSON body of
up to 128 KiB that contains `text`. Extra fields cannot change the destinations.
Every destination must remain connected and enabled. If one of them is not when
the request arrives, the Home rejects the request with a 400 error and sends
nothing to any destination.

The Home keeps a separate delivery identity for each destination under the same
`Idempotency-Key`. When the sender repeats a request, the Home reuses the stored
receipt of each chat it already tried under that identity and never sends to
that chat again. If the sender repeats an identity with changed text for any
destination, the Home returns 409 before it checks the destinations, and it
sends nothing.

A 200 response means that Telegram confirmed delivery to every destination. With
one destination, the response contains the existing Telegram outbox receipt and
confirmed message IDs. With several destinations, it contains `sent`, `status`,
the first destination's `chatId`, and `deliveries`, which holds one such receipt
per destination in the configured order:

```json
{
  "sent": true,
  "status": "delivered",
  "chatId": "<connected destination>",
  "deliveries": [
    {"sent": true, "status": "delivered", "chatId": "<connected destination>", "title": "...", "messageId": "...", "telegramMessageIds": ["..."]},
    {"sent": true, "status": "delivered", "chatId": "<another connected destination>", "title": "...", "messageId": "...", "telegramMessageIds": ["..."]}
  ]
}
```

If Telegram does not confirm delivery to one or more destinations, the Home
returns 502 and never resends those deliveries automatically under that identity.
The 502 body has an `error` message. With several destinations, it also has
`sent` set to false, the receipts in `deliveries`, and a combined `status`:

- `unknown` means the Home cannot tell whether at least one destination received the text.
- `pending` means an earlier request is still sending to at least one destination.
- `partial` means some destinations received the text and the others did not.
- `not_sent` means no destination received the text.

A destination can stop being connected or enabled while the Home is sending to
an earlier destination. Its receipt then has `sent` set to false, the status
`not_sent` and an `error` message. The Home never tried that destination, so a
repeated request sends the text there once it is available again.

Inspect Telegram and the saved receipts before any manual recovery. Removing the
setting disables the endpoint.

## Narrow keys

A service that sends approved material to one chat at a time, such as a school
sending a parent's report to that family's group, gets its own key instead of the
credential above. The same setting lists the keys:

```json
{"keys":[
  {"id":"school-drafts","tokenHash":"<SHA-256 hex of its own random token>","chatIds":["<owner's private chat>"]},
  {"id":"school-reports","tokenHash":"<SHA-256 hex of another token>","chatIds":["<family group>","<another family group>"],"maxPerHour":30}
]}
```

- A key has an `id` (lowercase letters, digits and hyphens, up to 40; `legacy` is
  reserved for the credential above), its own `tokenHash` and 1 to 50 distinct
  `chatIds` written as Telegram gives them (no leading zeros). Up to 20 keys.
  `maxPerHour` (1 to 1000, default 30) caps its new deliveries per hour.
- If any key is malformed, or two keys share an `id` or a token, no key works. The
  credential above keeps working either way, and it may also be absent.
- A request sends one Telegram message to one chat: the text must fit one message
  (4096 characters after formatting), so the hourly cap counts what a chat receives.
  With one listed chat, `chatId` may be omitted; otherwise the body names it, and a
  chat the key does not list is refused (403). `linkPreview` and `silent` (true or
  false) are optional.
- The Home reads the setting again once the request body has arrived (it allows 30
  seconds for that), so removing a key or one of its chats also stops a request
  that is still arriving.
- A key may post to a protected group (see `scoped-telegram-access.md`) only when
  it lists that group and the access policy has the group enabled. Switching the
  group off refuses new requests (403) and stops a delivery between its parts.
  A limited participant's private chat is never reachable. The credential above,
  model turns and schedules still never post to a protected audience.
- The key's `id` is part of each delivery's identity, so two keys never share or
  block each other's deliveries. Repeats, changed text (409) and unconfirmed
  delivery (502) behave as above. A repeat of an earlier delivery is answered even
  over the hourly limit; a new one over it gets 429.
- A key's 502 also carries the receipt: `sent: false` and a `status`. `not_sent`
  means Telegram refused the text and nothing arrived. `unknown` or `pending` means
  it may have arrived: look at the chat before any new delivery, which needs a new
  `Idempotency-Key`.
- Supergroup upgrades move a key's chat IDs like the fields above.

The Home journals every delivery of this endpoint in the `notification_deliveries`
table: the caller (`legacy` or the key's `id`), chat, `Idempotency-Key`, SHA-256 of
the text, status, the Home message ID and Telegram message IDs, attempts and times.
It keeps no text. A narrow key sends nothing unless its journal row is written.

Remote callers must verify TLS. For a Home using its self-signed certificate,
pin the SHA-256 digest of the DER-encoded public key (SPKI), obtained through
the trusted deployment connection. Do not disable TLS verification globally.
