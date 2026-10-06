# Agent characters and device sign-out: design QA

Date: 2026-10-06

final result: passed

Scope: the existing Mac, iPhone, iPad and browser interfaces. This is acceptance
of the new appearance picker and device sign-out flow, not of paid hosting.

- Original transparent pastry characters were generated as individual assets.
  The six source images and the implemented picker were reviewed together.
  Broad silhouettes and faces remain distinct in the sidebar and chat header.
  The infinity strudel remains the application icon and main assistant mark.
- Cream and graphite appearances were inspected in the running Mac/web UI.
  Browser layouts were exercised at 1280×720 and 390×844. Dialogs scroll within
  the viewport; the appearance grid is 3×2 and narrow-screen colors are 4×2.
- Native iPhone and iPad UI tests exercised choose, save, reopen, cancel logout,
  confirm logout and relaunch. All passed. The largest accessibility text size
  also passed after fixing the picker header wrapping and fixed-size checkmark.
  The exit sheet uses the short title «Выход» and scrolls to its actions.
- Selection uses shape borders/checkmarks in addition to color. Controls have
  readable accessibility names and selected traits. Touch targets have at least
  44 points in the color picker. There is no animated/spinning character.
- Editing an existing employee and cancelling preserves the stored appearance.
  A saved selection was checked across web and native clients.
- Mac file export cancellation keeps the connection. A successful export exits.
  With two linked disposable Homes, an unavailable worker produced a readable
  error and preserved the session. Reconnecting it produced two valid archives
  containing 9 profiles (including both main assistants) and 7 messages; exit
  occurred only after both files were saved by the system dialog.
- Browser cancellation preserved the session. The downloaded archive was opened
  and verified (7 profiles with appearances). Explicit exit returned to the
  invitation screen. The browser download-event observer timed out, but the
  actual downloaded file and successful exit were independently confirmed.
- Standalone macOS Settings closes via «Готово». Settings are also reachable
  from the Chats toolbar while viewing any employee.

Evidence: private `.data/agent-characters-2026-10-06/` contains native/web
screenshots, successful Xcode result bundles, export checks and regression logs.
The fixture runs real Home APIs and local TLS pairing with disposable databases;
it does not purchase infrastructure or use a user's OpenAI session.

Regression evidence: 226 Home tests on Mac; 220 passed / 2 platform-specific
skips in the Linux image; 89 native unit tests; successful iPhone, largest-text
iPhone and iPad UI scenarios; TypeScript and macOS Release build passed.

Limits: exhaustive combinations of every external service/network state are not
claimed. VoiceOver semantics were inspected through accessibility trees; a
separate human VoiceOver usability study was not performed. Offline exit removes
the local credential even when the server cannot acknowledge revocation.
