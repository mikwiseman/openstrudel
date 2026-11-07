# Personal apps

A personal app is a small native app with one job, such as choosing a film tonight or planning a trip. It is another client of the owner's Home. It has no model, account or memory of its own: the Home's main assistant does the thinking, with everything it already knows about the owner.

## Connect

The app pairs like the OpenStrudel app. The owner opens **Settings → Devices → Share access… → My device** and pastes the link into the app. The app checks the Home's TLS key from the link, sends `POST /pair` with the link's key and keeps the returned credential in its Keychain. Settings lists the app among connected devices and can revoke it. Use an owner link: only the owner's requests receive the owner's knowledge.

## One chat per app

The app sends `POST /v1/messages` with `externalChatId: "app:<name>"` and a `title`. This creates one conversation of the main assistant for that app, apart from the main chat. Its turns use the same account, the personal workspace and its `MEMORY.md`, native Codex memory and the owner's source catalogue. What the app sends and receives stays in that conversation's history, so the assistant knows it next time, in the app and in every other chat.

## Structured answers

`outputSchema` is a JSON Schema whose root is `type: "object"`, at most 64 KB. The final answer of that turn is one JSON document that matches it, and the response's `text` is that document. Codex receives the schema in the native `turn/start`; Claude receives it as the SDK's `outputFormat`; Grok refuses the request instead of returning prose. The schema applies to that turn only. Tools, the thread and later turns are unchanged.

```json
{
  "text": "Choose the next films for Mik…",
  "externalChatId": "app:cinema",
  "title": "Cinema",
  "externalId": "5e3b3c1e-6d0f-4bb8-9d2a-2f6f7c8f3a10",
  "outputSchema": { "type": "object", "required": ["films"], "properties": { "films": { "type": "array" } } }
}
```

## Thinking level

An app can send `reasoningEffort` (for example `"medium"`) for its own chat. It applies while the owner has chosen no model for that chat; a model chosen for the chat in OpenStrudel always wins, and the engine fits the level to the model it runs. Measured on 7 November 2026 on Wolf with GPT-6 Astra and the same film request: xhigh answered in 152 seconds, medium in 27, with picks of the same quality. A swipe deck cannot wait two and a half minutes, so Cinema asks for medium.

## Retries

Send a new `externalId` UUID with every request and keep it until the answer arrives. Sending the same request again returns the saved answer and does not start another turn. Without `async=true` the call waits for the answer; there is no total turn timeout. With `async=true` the app receives the receipt at once and reads the answer from the conversation later.

## What stays in the app

Display state only: the cards on screen, cached pictures, what is waiting to be shown. Anything the assistant should remember about the owner goes through the conversation.
