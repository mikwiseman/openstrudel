# Codex sandbox in Docker

The runtime stays non-root with all Linux capabilities dropped and `no-new-privileges` enabled. Codex still enforces each employee's filesystem and approval policy. Do not use `--privileged` or disable the Codex sandbox.

The two profiles are adapted from OpenAI's `codex-security` project, commit `10e7a22461329083414713c379e97a0c352647fe` (Apache 2.0, license included):

- `docker/codex-security-seccomp.json` → `seccomp.json`, unchanged.
- `docker/codex-security.apparmor` → `openstrudel.apparmor`, profile name changed to `openstrudel-container` only.

They allow Bubblewrap to create its own user and mount namespaces without granting host capabilities. The AppArmor profile retains restrictions on `/proc`, `/sys`, and kernel interfaces. Load it on the Docker host before starting the service:

```sh
sudo apparmor_parser -r deploy/docker/openstrudel.apparmor
```

Required container flags:

```sh
--cap-drop ALL \
--security-opt no-new-privileges:true \
--security-opt seccomp=deploy/docker/seccomp.json \
--security-opt apparmor=openstrudel-container \
--security-opt systempaths=unconfined
```

Keep `/data` in a named volume; the image initializes it for UID 1000. Never mount the Docker socket, a personal Codex home, or other users' directories.

Docker's masked `/proc` submounts prevent Bubblewrap from mounting its inner procfs. `systempaths=unconfined` removes those outer masks for this container only. The supplied AppArmor profile must remain enabled to enforce its `/proc` and `/sys` restrictions instead; do not combine this option with `apparmor=unconfined`. Host sysctls and other containers are unchanged. This is a single-owner runtime, not a shared multi-tenant execution sandbox.

Hosts must support user namespaces. Container hosting services that do not accept these sandbox settings are not yet supported. A successful health check or OAuth login does not prove Codex can execute: verify a real turn and a workspace file operation before publishing an installer.
