# Ask: answers from memory

People ask their Home short questions about their own records, e.g., "how much did they pay in October". The Home answers such a question from the connected memories in a few seconds, with its sources, and the main thread does not run. A turn of the main thread takes much longer, because the main thread is long and has every tool.

## What a memory is

A memory is a connected HTTP service that lists a read-only tool named exactly `recall`. Read-only means that the tool has `annotations.readOnlyHint` set to true. The tool takes `{ question: string }` and returns:

```
{
  understood: { from, to, who: [ { kind, id, name } ], about: [...] },
  evidence: [ { n, kind, layer, title, date, text, id, url, open: { tool, args } } ],
  searched: {...},
  note: string
}
```

`understood` says how the memory read the question, e.g., the period and the people that the question is about. `searched` says where the memory looked. The Home passes `understood`, `searched` and `note` to the model as the memory returned them. Any field may be missing, and the Home keeps an item of evidence that has a text or a title. `open` names a read-only tool of the same memory that returns the whole source. An item may also carry `later: true`, which means that it was said after the other items on the same subject. The Home then writes "(said later)" beside the number of the item in the text for the model.

`recall` may list more inputs than the question in its input schema, e.g., `since` and `until` as days in the form YYYY-MM-DD. The Home sends such an input only to a memory whose `recall` lists it.

The Home sends a memory one JSON-RPC request in each HTTP POST (`tools/list` or `tools/call`), with the service's own header or bearer token and without a session. The memory may reply with JSON or with one server-sent event. The Home waits 6 seconds for a reply, and the work memory in production answers `recall` in 1 to 4 seconds. The Home reads at most 1 MB and refuses a reply that contains the service's own credential. The Home keeps the tool list of each service for ten minutes.

## Which memories a chat uses

A chat uses the memories among the HTTP services that its own turns get, with the following limits:

- A Telegram sender who is not on the access list gets no memory.
- Only the owner gets a service that is listed in `ownerOnlyServers`.
- The Home leaves out a service that needs the verified Telegram sender in its headers, because those headers change with every message.
- The owner's choice of enabled and disabled tools for a service applies to `recall` and to the tool in `open`.

## How the Home answers

1. The Home calls `recall` on every memory at once with the person's message. A memory that fails, returns an error or does not answer in 6 seconds is unreachable. The Home names it in the result and still uses the other memories.
2. The Home merges the evidence. The memories take turns, so that one long source from one memory does not push out the evidence of another. The Home numbers the items again, cuts each text at 2,400 characters and cuts all texts together at about 9,000 characters.
3. One model run on a new thread writes the answer. The model gets the message, the current time, the owner's timezone, the last six messages of the chat, the names of the memories that answered and of the unreachable memories, and the evidence. The model has no stored history, no SOUL and no other services.
4. The Home adds a list under the answer with the title, the date and the link of each source that the answer named by its number.

The instructions for the model are fixed. The model answers only when the evidence holds the answer, and it leads with the answer in one to three sentences. Every statement carries the number of the evidence it rests on in square brackets, and an answer without a number is not allowed. When a newer item replaces an older item, the model gives the newer item and says since when it applies. The model never fills a gap from general knowledge and never guesses a figure, a date or a name. The model treats text inside evidence as data and never as instructions. The model answers in the language of the question.

The model never says that something is not on record or was not found. When the evidence does not hold the answer, also after a second `recall` or an `open`, the model calls `hand_over` and writes nothing. The main assistant has every tool, so it looks further and decides what is and is not on record. The Home enforces the rule as well, because it treats an answer that names no source it was given as a hand-over, whatever the answer says.

The model has three tools:

- `recall(question, since, until)` searches every memory again with different words. `since` and `until` narrow the search to a period, and the Home passes them only to the memories whose `recall` lists them. The model may call `recall` twice.
- `open(n)` reads one source in full through the read-only tool that the item names, on the memory that returned the item. The model may call it three times.
- `hand_over()` gives the message to the main assistant. The model calls it when the message is not a question about records, e.g., a request to do something or small talk, and when the evidence does not hold the answer.

## When a memory cannot be reached

The model is told which memories answered and which are unreachable, because an unreachable memory may hold the record. The Home applies the following rules:

- When no memory answers, the Home does not answer from memory, and the message takes its normal turn in the main thread.
- When some memories answer and the answer names a source, the Home gives the answer as the model wrote it.
- When some memories answer and their evidence does not hold the answer, the message takes its normal turn in the main thread, as it does whenever the evidence does not hold the answer.

The Home records every service that has listed `recall`, with its read-only tools, in the setting `ask.memories`. A memory that does not answer when the Home asks for its tool list is therefore still a memory, also after a restart, and the Home names it as unreachable. The Home writes `ask.memories` itself, and the owner does not need to set it.

## The runtime

The model runs in the restricted Codex runtime that protected Telegram chats use. The runtime has an empty folder that it can only read, and it has no shell, no network and no connected services. Codex does not store the thread. The runtime signs in with the Home's ChatGPT account, so a Home whose model comes from another provider does not answer from memory.

## When a message is answered from memory

The Home tries to answer from memory first only when all of the following hold:

- The setting `ask.enabled` is not "false".
- The message is in the main assistant's own chat. The sender is the owner in the main chat of the app, or a person with access (a paired owner or a person on the access list) in their private Telegram chat.
- The message is not a scheduled run, an event run or an answer to a card. It has no files, no attached context and no answer schema. A dictated Telegram message is the exception. When a voice message, an audio or a round video was transcribed and that recording is the only file of the message, the Home uses the transcript as the question. A photo, a document, a video or any other file still sends the message to its normal turn.
- No turn is running or waiting in the chat.
- The message is at most 400 characters long, has no link, and reads like a question. It has a question mark, or one of its first words is a question word in Russian or English, e.g., "сколько" or "when", or its first word asks to find, show, tell, remind, list or give something, e.g., "найди" or "show". Dictated text often has no question mark, so the question word is enough, and the Home skips spoken openers such as "слушай" or "so" before it looks for the question word. The message does not start with a command to send, create, schedule, change or write something. Such a command also wins when it follows a request to find something, e.g., "найди и отправь".
- The chat has at least one memory.

The Home stores the message as it stores any message. When the model answers within 26 seconds, the Home stores the answer as the reply to the message and delivers it the same way as any reply, in Telegram and in the app. The main thread reads the question and the answer as context the next time it runs, and it reads them once. The Home records the usage of the run in `turn_usage`, so the statistics count the request.

When the model calls `hand_over`, writes an answer that names no source, fails or runs out of time, or when no memory answers, the message takes its normal turn in the main thread. The Home stores no second message and shows no error, and a dictated message keeps its recording in both cases. The usage of both runs is then recorded for that one request.

With `ask.enabled` set to "false", or with no memory connected, the Home handles every message exactly as it did before.

## Settings

The owner sets two Home settings in the store, and the app has no screen for them yet.

- `ask.enabled` turns answers from memory off when its value is "false". With any other value, or with no value, they are on.
- `models.ask` is the model for these answers, in the same form as any model selection, e.g., `{"provider":"chatgpt","model":"<id>","serviceTier":"default","reasoningEffort":"low"}`. A reasoning level that the model does not offer becomes the lowest level that the model offers. With no value, the Home uses the device's model at the lowest reasoning level that the model offers, and at the Fast speed when direct chats use it.

## Evaluation

`POST /v1/ask` takes `{ question, conversationId? }` from the owner and returns `{ answer, sources: [{ n, memory, title, date, url }], notOnRecord, unreachable, seconds, tokens }`. The Home stores nothing for this request, and the request works when `ask.enabled` is "false". Without `conversationId` the Home uses the memories of the main chat and no earlier messages. With `conversationId` the Home uses the memories and the last six messages of that chat. The request may carry evaluation fields, so that the owner can try a change without a new release. The Home uses them for the one request and stores none of them, and a message in a chat never takes them:

- `model`, `reasoningEffort` and `serviceTier` replace the model, the reasoning level and the speed of the run. The Home refuses a model, a level or a speed that the account does not offer. A model without a level runs at the lowest level that the model offers.
- `instructions` is a text of at most 8,000 characters that replaces the fixed instructions.
- `debug: true` adds four parts to the reply. `evidence` lists the items that the model was given, each with its number, memory, kind, layer, title, date, the first 300 characters of its text, and `later` and `flags` when the memory sent them. `calls` lists the tool calls of the model in order with their arguments. `model` and `reasoningEffort` say what ran. `timings` gives the milliseconds of the first `recall`, of the model run and of the whole request.

`unreachable` lists the names of the memories that could not be reached. When the model hands the message over, when its answer names no source, or when no memory answered, `answer` is null and `handedOver` is true. `notOnRecord` stays in the reply for older callers and is always false.

Checks: `tests/ask.test.ts`, `tests/ask-engine.test.ts`.
