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
