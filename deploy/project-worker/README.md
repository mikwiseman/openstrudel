# Remote project builds

Wolf accepts project requests from the configured Telegram senders in their private chats and from listed paired owner devices. Codex checks out the requested GitHub revision inside a fresh Linux container. Wolf holds the GitHub App key, issues a read token limited to that repository, and imports the resulting patch before opening a pull request. The container has no Docker socket, host filesystem mounts, SSH identity or OAuth refresh token. The model's shell runs offline. Use the repository's CI for checks that need downloaded dependencies, a native SDK or signing.

The service account `wolf-dev` owns the operator's personal terminal. Install the official Codex CLI at `/opt/wolf-tools/codex` and use `codex login --device-auth` as that user. For personal Claude Code, use the official `claude auth login --claudeai` flow in the same terminal. The optional [systemd unit](wolf-codex.service) serves the personal Codex client over a Unix socket accessible to that user. For an SSH client, run `codex app-server proxy --sock /run/wolf-codex/app.sock` as that user.

## Worker

1. Build the worker image from this repository with `docker build -f deploy/project-worker/Dockerfile -t wolf-project-worker .`. Install the existing [Docker sandbox profile and seccomp rules](../docker/README.md). Place the seccomp file at `/etc/wolf-project-worker/seccomp.json`.
2. Install `account.mjs` at `/opt/wolf-tools/account.mjs` and `launch.py` at `/usr/local/sbin/wolf-project-job`. These files and the image configuration must be root-owned. Set `/etc/wolf-project-worker/config.json` to an object with the expected ChatGPT `email` and immutable Docker `image` ID, including the `sha256:` prefix. The launcher delegates only the short-lived subscription token.
3. Create a separate SSH user for Wolf. Restrict its authorized public key to the Home's IP with `from="HOME_IP",restrict,command="/usr/bin/sudo -n /usr/local/sbin/wolf-project-job"`. Grant that user sudo for precisely `/usr/local/sbin/wolf-project-job ""` with no arguments. Keep this account outside the Docker group.
4. Generate the SSH identity on the Home. In its private `.data/project-worker/` directory, store the mode-600 key as `identity`, the worker's independently verified host key as `known_hosts`, and the following configuration as `config.json`. The Home process must own the directory. Personal terminal credentials stay on the terminal account.

```json
{
  "host": "build.example.org",
  "user": "wolf-build",
  "telegram": ["OWNER_TELEGRAM_ID"],
  "devices": ["OWNER_DEVICE_ID"],
  "releases": {
    "example/web": "push",
    "example/openstrudel": "home"
  }
}
```

Configure `push` only when a push to the repository's default branch triggers its existing deployment. The `home` route uses the owner's installed OpenStrudel updater and its rollback check. Other repositories can be checked, changed and submitted as pull requests. AiGid's separate requester list, Xcode Cloud workflow and TestFlight groups control iPhone releases. Apple signs the build in Xcode Cloud.

For a rollback, disable the Home worker during an idle window by moving its configuration aside and restarting the Home, or select the previous tested image on the build host. The Home retains requests in its SQLite queue. A dispatched receipt records the handoff. Verify the resulting artifact or deployed service with its provider.

## Additional server checkouts and packages

The owner's `project_repositories` tool also lists checkouts registered on the project server. Install `portfolio.py` in `/opt/wolf-tools` and register each canonical repository and default branch in `/etc/wolf-project-worker/projects.json` and the Home configuration's `portfolio` object. The operator's Git process fetches source into a fresh bare repository. Only that source is mounted read-only in the model container. A changed candidate is saved on a private branch in the operator's checkout. For repositories that already build and merge a pushed branch, set `delivery` to `branch`. Only an explicit release request pushes that branch.

`project_package` builds registered Android debug APKs or static web ZIPs in a disposable Linux container. Register the project root and expected Android application ID in the server's `packages.json`, and the target names under `packages` in the Home configuration. Build the package image with `Package.Dockerfile`, install `packages.py` and `sign-qa.py` in `/opt/wolf-tools`, and enable `package-network.sh` after Docker starts. The build bridge allows public web dependency downloads and blocks the host and private networks. Each APK is signed after the build with its project's stable QA key in the separate `wolf-qa-sign` account. Serve `/var/lib/wolf-package-downloads` over HTTPS with directory listings disabled and remove expired downloads through systemd-tmpfiles. Wolf returns the temporary link, byte size, source revision and SHA-256 in the requesting chat.

The OpenStrudel `macos` target dispatches the repository's `wolf-macos.yml` workflow. GitHub hosts the Apple silicon runner and retains the QA client download for seven days. This client connects to a remote Home. Production Developer ID releases use the signing and notarization steps in [the Mac release guide](../../docs/mac-release.md).

For TestFlight completion messages, register `/hooks/wolf-testflight` as a GitHub repository webhook with the `status` event and a private shared secret. Store that secret as mode 0600 in `.data/aigid-testflight/github-webhook-secret`. Configure the Apple app ID, Xcode Cloud status context in `workflow`, and the TestFlight install URL. Wolf accepts the authenticated Xcode Cloud bot's terminal status for the exact release commit and sends the result to the requesting conversation.

To include Apple’s build number, set `appleWorkflowId` to the native Xcode Cloud workflow UUID. Generate a 32-byte random token as 64 lowercase hexadecimal characters in `.data/aigid-testflight/apple-webhook-token` (mode 0600, owned by Home). Register `/hooks/wolf-testflight/apple/<token>` at the public HTTPS origin under the product’s Xcode Cloud **Settings → Webhooks**. Route that path to the Home event listener and keep the URL out of access logs. Jobs dispatched after setup match Apple’s run UUID, source commit, app and workflow to the GitHub-signed result. Either event can arrive first. A signed terminal result is delivered immediately. If the number arrives later, Wolf adds it to the original Telegram and Home reply. Retries and restarts reuse the same result.


For a registered BBF branch release, configure a repository webhook for `pull_request` and `issue_comment`. For a site with a verified Vercel production integration, set its release route to `vercel` and subscribe to `deployment_status`. Use the HTTPS path `/hooks/wolf-projects/<owner>/<repo>` and a separate secret for each repository in `.data/project-worker/webhooks/<owner>/<repo>` (mode 0600). Wolf matches the deployment to the originating source revision or worker pull request. The final provider link or failure returns to the requesting chat.

To use a shared AiGid tester group, add its verified Telegram chat ID to `groups` in `.data/aigid-testflight/config.json` and approve both testers as senders in OpenStrudel. In a private or shared tester chat, send a bug report, voice note or screenshot. Wolf posts the proposed change in that chat. Tap **Edit plan** or reply with a correction. **Approve & build** queues the displayed version. Approval of an older version has no effect. Wolf reports the Xcode Cloud handoff and posts the result with a TestFlight button. Asking for a build of current main follows the same review flow and preserves the source.

For other projects, Wolf shows the selected repository and delivery destination before approval. A QA package returns a download in the originating chat. An approved release uses the project's configured deployment route.


For repositories with no registered deployment, list the verified GitHub repositories in `sourceRepositories` to let the owner explicitly publish a checked source change. App installations use a pinned pull request and GitHub's merge API. For a personal SSH checkout also set `sourceMerge: true` on the matching server registry entry. The broker accepts the exact candidate over its unchanged parent on the registered default branch. Wolf returns the GitHub commit link.

For an existing GitHub Pages site published from the default branch, use the `pages` route and subscribe its project webhook to `deployment_status`. Verify the Pages publishing source and canonical URL in GitHub before registering it. A website release is an explicit destination. The callback includes the published site and revision. Push deployments using `.github/workflows/deploy.yml` subscribe to `workflow_run` for the final run link.
