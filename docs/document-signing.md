# Document signing source restoration

On 2 November 2026 the typed source was reconstructed from the running Wolf image
`openstrudel:signing-025d56d`, image ID
`sha256:7fecce54f5690cc4b6452db480c786e21a88bb28463f59a8c97c6966ada1c41a`.
The original commit `025d56d2625d9f9e75d9977f6e5533045a79620d` was unavailable;
this is reconstructed source, not a recovered original commit.

Compiling the restored source reproduces the running `document-signing.js`,
`personality.js` and `files.js` byte for byte. The Python wrapper is also identical.
The image's shipped TypeScript did not include signing; rebuilding from it would
have removed the production feature.

The native `sign_document` tool retains the existing authorization checks: a
current Telegram request from the configured paired owner, an enabled chat,
native access and a permitted workspace. API owner flags, schedules, other
senders and restricted chats do not grant signing. Authorization is rechecked
before work and before publishing rendered output. Explicit intent to sign and
inspection of the returned previews remain requirements of the tool instructions.

The existing private installation at `.data/sign-document` contains its
`config.json` with `telegramUserId`, `SKILL.md`, executable and assets. These are
never bundled or copied into an agent workspace. The shipped Python wrapper loads
that installation explicitly. The Docker image includes the five dependencies
verified in the running signing layer: `python3-fitz`, `python3-numpy`, `python3-pil`,
`libreoffice-writer` and `fonts-liberation2`. Mac bundles include the wrapper;
this change does not install or verify Mac document-processing dependencies.

`tests/document-signing.test.ts` uses synthetic documents and a mocked subprocess
to verify owner and audience boundaries, revocation, workspace path checks and
cleanup. It neither uses real signatures nor establishes end-to-end signing QA.
