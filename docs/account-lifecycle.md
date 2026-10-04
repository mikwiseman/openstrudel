# One OpenAI account per Home

The Home is the Mac or server that runs the agents. Its owner explicitly starts
OpenAI sign-in and authorizes their account on OpenAI's page. A fresh installation
never adopts `~/.codex` or an unrelated `CODEX_HOME`. Paired clients hold only a
Home connection credential and TLS pin, not OpenAI OAuth credentials.

| Situation | Behavior |
| --- | --- |
| First setup | The owner sees a sign-in button. No login begins without a click. |
| A second device connects | It uses the Home's account; no additional OpenAI login. |
| App or Home restarts | The existing Home account and pairing are reused. |
| Access token needs renewal | Codex on the Home refreshes it. Worker contexts use external access tokens and request renewal from the same Home; they do not receive refresh tokens. Concurrent renewal requests are coalesced. |
| OpenAI rejects authorization | The Home stays connected. The client explains that sign-in must be restored; existing chats and drafts remain visible. Sending is disabled until recovery. |
| OpenAI is temporarily unavailable | Show a retry notice and check again. Do not classify the outage as revoked pairing or delete credentials. |
| Another owner device starts login | Join the pending Home login instead of canceling it. |
| Login is canceled, expires or is lost on restart | End the pending UI state and allow another attempt. A canceled account switch preserves the prior account. |
| The same account signs in again | Restart workers with the renewed account and preserve thread IDs and chat history. |
| A different account signs in | Keep chat records, but start new Codex threads for the new identity. |
| A Home pairing credential is revoked | Request a new Home invitation. This is separate from OpenAI sign-in. |

Only the local Home owner and clients paired with an owner invitation can start,
inspect, cancel or change OpenAI login. Ordinary paired clients see shared account
status and wait for the owner to recover it. Remote owners use device-code login,
so a browser callback is never accidentally sent to the remote server's localhost.
OpenAI may require the owner to enable device-code login in ChatGPT security
settings, or obtain permission from their workspace administrator. The code screen
explains this; OpenStrudel never changes those account settings itself.

Worker credential storage is ephemeral. This also prevents a worker upgraded from
an older release from loading its old `auth.json`; the Home remains the only OAuth
refresh owner. Switching Homes scopes local drafts to the original Home address.

Native clients refresh shared account status every 10 seconds. The Home coalesces
reads and caches healthy status for up to 30 seconds (failure for 5 seconds).
Login completion and authentication errors invalidate that cache. Explicit retry
bypasses the cache. A recovery on one owner device therefore propagates to the others.

An interrupted or rejected agent turn remains failed with a readable error. Signing
in does not automatically repeat it, because an external action may have already
happened. Scheduled runs retain their receipts; later scheduled runs use the restored
account. The login flow never creates, duplicates or replays schedules.

Acceptance includes service tests, native client tests, the opt-in
`AccountRecoveryUITests` fixture (first login, cancel, history/draft preservation,
outage, reauthentication, relaunch and ordinary paired client), and real bundled
Codex checks with an invalid disposable account. A synthetic successful login is
not evidence of a completed human OAuth authorization or a successful inference turn.
