# One chat and Clients

The app has one conversation and one composer: the chosen Home's main assistant. Connected services (calendar, mail, the company tools, MCP servers) sit underneath it and the Home's runtime routes each request; nothing is chosen in the UI. The second tab, Clients, reads the owner's business clients from the same Home. Everything else that used to be a chat of its own — an employee's history, its News edition, a Telegram group — is a reader: it can be searched and quoted, never written to.

## Where things are

| Surface | Native | Home |
|---|---|---|
| The chat | `ConversationView.swift`, `Composer.swift`, `Transcript.swift`; `HomeClient.pinToMain()` keeps the composer on the main assistant | `POST /v1/messages` with an optional `context` |
| Readers | `RootView.swift` (`ReaderRoute` path), `ReaderViews.swift`, `ConversationReader.swift`, `EmployeePicker.swift` (the list) | the existing conversation and News routes, read only |
| Clients | `ClientsView.swift`, `ClientsModel.swift`, `HomeClient.fetchClients` / `fetchClientFiles` | `GET /v1/clients`, `GET /v1/clients/:id/files` (`src/clients.ts`) |
| Which Home is the chat | `DeviceLibrary.select` (one guard for Settings, the Home menu and pairing), `primaryChangeBlocker` | — |
| Connections | Settings → Connections (`ConnectionsView`) | unchanged |

## What a message can carry

`ChatContext` (native) and `MessageContext` (`src/message-context.ts`) are the same thing: a business client, a quoted message, or a quoted News story. The Home resolves it at send time:

- A client is verified against the source it was listed from — connector name, endpoint and a fingerprint of the connection — before the turn starts. A client from another connection is refused (`client_source_changed`); an unknown one too (`client_unknown`).
- A quote from this Home is read back from the store by id, so the engine sees the authoritative text.
- A quote from another Home travels as bounded text with that Home's identity and name. The app sends it only while that Home is still paired as itself; otherwise the words wait with the quote, and the owner can drop the quote and send the words alone.

The context is stored with the message, shown over it in the transcript and in the readers, and read back into history and owner knowledge without the connection fingerprint.

## Clients

`ClientsAdapter` talks Streamable HTTP JSON-RPC to the company MCP server found among the main chat's connectors (the one that offers `company_clients_list` and `company_client_files_list`). It reads; it never writes. The remembered connector is tried first; a second one offering the same tools is `ambiguous` until the owner trims the connections. HTTP 401 is `service_auth`, 403 `service_denied`, anything else `service_unavailable`; a response that echoes the connection's secret is refused before any projection. Only the device owner sees clients (`owner_only`). The route is served by the Home's main node.

Lists are cached for a minute and the discovery for ten; verification before a send never uses the cache.

## The chat's own queue

Each Home has one pending file and one queue owner, the chat's `HomeClient`. A send queued for an employee or a Telegram chat by an earlier version is still delivered once, under its own id and destination, and stays visible in the chat with «Для: …» until the Home's receipt clears it. A cancelled or refused send can be discarded; discarding never sends. The chat moves to another Home only when nothing is pending: no draft, no files, no attached context, no question waiting, no answer in flight, no unconfirmed send. Removing the chat's own Home is the same move with the same guard; a renewed invitation for the same Home keeps the chat and its queue.

## Proof

- `tests/clients.test.ts`, `tests/clients-routes.test.ts`, `tests/message-context.test.ts`, `tests/context-turns.test.ts`, `tests/clients-routing.test.ts`, `tests/knowledge.test.ts` — the Home side.
- `native/OpenStrudel/Tests/OneChatTests.swift` — pinning, drafts and contexts across relaunch, the move guard, legacy sends, foreign quotes, client states.
- `tests/fixtures/one-chat.ts` + `native/OpenStrudel/UITests/OneChatUITests.swift` — the whole flow on an iPhone simulator against a disposable Home with a fake company service: two services in one conversation, three readers, Discuss into the draft, a client sent with its context, and every refusal state.
