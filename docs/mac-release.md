# Mac releases and Sparkle

OpenStrudel uses Sparkle 2.10.0, pinned by immutable revision in `native/OpenStrudel/project.yml` and `Package.resolved`. Only the macOS target links it. The update feed is `https://waiwai.is/openstrudel/updates/appcast.xml`.

Automatic checks are enabled by default. Downloads/installations require the user's confirmation. The setting and “Проверить обновления…” menu use Sparkle's own updater. Both the feed and its archive must have valid Ed25519 signatures; the app also requires verification before extraction. Profiling and automatic installation are disabled.

## Signing credentials

The permanent OpenStrudel public key is `1vr8F09jobPqwo22O0M7Sm3PNuLP1GmGsJopfN6rX7U=`. The release machine stores its private seed in the login Keychain under account `OpenStrudel`, with a protected backup at `~/.openstrudel/sparkle-key` (directory mode 0700, file mode 0600). Never publish, print, regenerate or replace this key. Losing it breaks delivery to installed apps. OpenRamble has a separate key and must remain untouched.

Apple signing uses the existing Developer ID identity for team `R4A779QVVY`, an unlocked release keychain, and the existing App Store Connect notary credentials. Do not commit credentials or embed them in scripts.

## Release sequence

1. Increase `CURRENT_PROJECT_VERSION` monotonically in `project.yml`, regenerate with XcodeGen, run native tests, and inspect both appearances, small phone, large Dynamic Type and iPad layouts. Test the actual cloud/API paths separately from disposable UI fixtures.
2. Build macOS Release for arm64. Bundle the public runtime with `scripts/bundle-mac-runtime.sh <app>`. That script includes only tracked runtime sources; private handoffs, migration scripts, local state and credentials are excluded.
3. Run `python3 scripts/sign-mac-app.py <app> --identity <Developer-ID-SHA1> --keychain <unlocked-keychain>`. This signs runtime Mach-O files and Sparkle helpers inside out, then the outer app. Only Node and the Codex code-mode host receive the JIT entitlement. Never use `codesign --deep` for signing.
4. Zip the app with `ditto -c -k --keepParent`, submit to `xcrun notarytool`, wait for Accepted, staple and validate. Build a DMG containing the app and an Applications link, sign it, notarize it, staple it and check Gatekeeper. Do not modify the app or DMG after this step.
5. Put the DMG in a clean feed work directory under an immutable name such as `OpenStrudel-1.0-8-arm64.dmg`, with a matching `.html` release note fragment. Use the tools from the pinned Sparkle SDK:

   ```sh
   generate_appcast --ed-key-file "$HOME/.openstrudel/sparkle-key" \
     --download-url-prefix https://waiwai.is/openstrudel/downloads/ \
     --embed-release-notes /path/to/feed-work
   ```

   The generator infers build, minimum OS and architecture, signs the archive and signs the feed. Do not manually edit signed XML. Independently verify the archive signature with `sign_update --verify` and compare the enclosure length and SHA256 to the final DMG.
6. Upload versioned archives before the feed. Verify the externally downloaded archive, then atomically replace the feed, stable download alias and checksum file with timestamped backups. The feed must be served over HTTPS with cache revalidation; immutable artifacts may be cached. Reload only the exact service whose configuration changed. Roll back on health-check failure.
7. Verify the production feed from the app and exercise download, signature verification, installation and relaunch using an isolated older QA bundle and test feed. QA bundle IDs must differ from `is.openstrudel.mac`, so they cannot start the user's personal Home. Preserve the working production runtime and schedules.

Versions predating Sparkle require one manual installation of the first Sparkle-enabled release. Later versions can update from the application.
