# OpenStrudel native clients

This directory contains one shared SwiftUI client with two native targets:

- **OpenStrudel iOS** for iPhone and iPad.
- **OpenStrudel macOS** for the Mac.

Both clients talk to the same OpenStrudel Home API. Home can run locally on a Mac or in the owner's DigitalOcean account. A phone pairs with the Mac over pinned HTTPS on the same Wi-Fi network; a cloud Home is reachable over the internet. The app is a thin native control surface: a person sees chats, employees, OpenAI account and Telegram.

Cloud setup uses DigitalOcean sign-in, displays the provider's current price, and requires confirmation before creating a server. The customer pays DigitalOcean directly. The connection screen retains a cloud management link while Home is offline. Stopping the app or server does not stop hosting charges; delete the server in DigitalOcean when it is no longer needed.

The targets require iOS 26 or macOS 26 or later. SwiftUI supplies Liquid Glass controls. Reply typography combines SF Pro text, New York headings and monospaced code, with real Markdown emphasis, links, lists and quotations. Short replies fit their content. Employee settings keep the editable character in a compact scrolling field alongside Telegram binding and schedule switches.

Foundation parses Markdown, including nested lists, fenced code and tables. Tables adapt to labeled rows on compact iPhone screens and with accessibility text sizes. System appearance and Dynamic Type remain enabled. Drafts are local to each client and conversation and survive relaunches. Arriving replies preserve the reader's scroll position and show a button to reach new messages.

## Generate and build

```bash
cd native/OpenStrudel
xcodegen generate
xcodebuild -project OpenStrudel.xcodeproj -scheme "OpenStrudel macOS" -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project OpenStrudel.xcodeproj -scheme "OpenStrudel iOS" -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Automatic PROVISIONING_PROFILE_SPECIFIER= build
xcodebuild -project OpenStrudel.xcodeproj -scheme "OpenStrudel macOS" -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test
```

The Mac app connects to the local Home at `http://127.0.0.1:7788`. In Mac Settings, choose **Подключить iPhone**. Scan the one-use code in the iPhone app, or open the shared connection link. Confirm the Mac and allow local-network access. Home must stay running on an awake Mac on the same network. The code expires after five minutes; creating another code invalidates the old one.

The code carries a `.local` hostname, port, one-use secret and SHA-256 certificate fingerprint. The iPhone pins that certificate and rejects redirects. A successful pairing replaces the invitation with a random credential stored in Keychain; Home stores only its hash. Mac Settings can revoke all mobile credentials. Signing must remain enabled for simulator connection tests too: an unsigned simulator build cannot reliably exercise Keychain persistence.

`UITests/iPhoneSmokeTests.swift` checks pairing, employees, imported history, bot settings, a fresh Codex reply and persistence after a cold launch. Pass a fresh connection link through the test runner's `OPENSTRUDEL_PAIRING_URL` environment variable. The test talks to the running Home and writes a short test message to the main chat. Keep result bundles private because XCTest records opened URLs; invitations expire and cannot be reused after pairing.

For TestFlight, use the existing WaiWai team `R4A779QVVY`, bundle `is.openstrudel.ios`, and an App Store provisioning profile matching the available distribution certificate. `ExportOptions.plist` shows the export settings; override its profile mapping for the signing machine. Version and build number live in `project.yml`. Archive/export success is not an upload or TestFlight availability; confirm the app record, successful upload and Apple's processed build separately.

Telegram is configured from **Settings → Telegram bot**. The token is sent to the authenticated Home, validated with Telegram `getMe`, stored by the Home and started without restarting the app or runtime. Create a short-lived chat code there and send `/start CODE` to the bot; this prevents an uninvited Telegram chat from using your Home.

Pin a linked Telegram chat in the employee's settings. The first chat shares the native conversation; additional groups have separate histories and are selected from the employee header's menu. Ask for a recurring request in conversation, then pause or resume it in the same settings. Imported history loads with the “Ранее” button. Telegram voice is transcribed on Home using OpenRamble on Mac or the bundled multilingual Whisper model in the Linux image.
