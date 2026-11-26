# Document signing in Telegram

The private signing installation names one Telegram signer in `telegramUserId`.
The signer's own explicit text, document caption or original voice message can
authorize signing in a DM or a connected group. Reply to a document or attach it
with the request. In the signer's DM, one request can cover preparing a notice
from an email, signing it and adding the company stamp. For example,
«Можешь составить документ и подписать и поставить печать?»
Groups that require mentions can address the bot by @username.
In forum topics and groups with restricted tools, signed copies go privately
to the signer.

`requesterTelegramUserIds` optionally lists people who may ask the signer to
approve a document. The bot sends the exact unsigned file, requested marks,
requester's name and originating chat to the signer's DM. Only the signer can
use the buttons on that message. Approval applies once to the reviewed copy.
The signed PDF goes to the signer, and the requester receives the decision in
the original chat. Declining closes the request.

Forwarded instructions, quoted text, anonymous messages, scheduled jobs and app
requests cannot authorize a signature. A direct reply to someone else's document
can. The per-turn tool checks the actual sender in both new and resumed chats.

## Source restoration

On 2 November 2026 the typed source was reconstructed from the running Wolf image
`openstrudel:signing-025d56d`, image ID
`sha256:7fecce54f5690cc4b6452db480c786e21a88bb28463f59a8c97c6966ada1c41a`.
The original commit `025d56d2625d9f9e75d9977f6e5533045a79620d` was unavailable;
this is reconstructed source, not a recovered original commit.

Compiling the restored source reproduces the running `document-signing.js`,
`personality.js` and `files.js` byte for byte. The Python wrapper is also identical.
The image's shipped TypeScript did not include signing; rebuilding from it would
have removed the production feature.

The native `sign_document` tool requires a
current Telegram request from the configured paired owner, an enabled chat,
native access and a permitted workspace. API owner flags, schedules, other
senders and restricted chats do not grant signing. Authorization is rechecked
before work and before publishing rendered output. The Telegram adapter provides
the sender's original words for the current request. The signing tool returns
page previews for inspection before the finished PDF is attached.

The existing private installation at `.data/sign-document` contains its
`config.json` with `telegramUserId`, `SKILL.md`, executable and assets. These are
never bundled or copied into an agent workspace. The shipped Python wrapper loads
that installation explicitly. The Docker image includes the five dependencies
verified in the running signing layer: `python3-fitz`, `python3-numpy`, `python3-pil`,
`libreoffice-writer` and `fonts-liberation2`. Mac bundles include the wrapper;
this change does not install or verify Mac document-processing dependencies.

`tests/document-signing.test.ts` covers direct signing. The approval and Telegram
transport tests cover document binding, sender identity, callback replay,
declines and private delivery. They use synthetic documents and marks.
