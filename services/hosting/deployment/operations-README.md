# WAI VDS production operations

Operations package for the documented production deployment. Installation and acceptance evidence are recorded in outputs/production-readiness.json. Target: `root@103.45.247.25`, `/srv/wai-vds`, exact container `wai-vds`. Existing Compose, application launch settings, Caddy and wai-pay monitors are unchanged.

## What runs

- Daily host backup at 03:10 UTC, with up to ten minutes of jitter. SQLite uses the online backup API while the app remains available. The master key, bootstrap signing key, runtime environment and release marker are checked for changes while copying. A standalone SQLite copy and manifest are validated before encryption.
- Standard [age](https://github.com/FiloSottile/age) encryption with an X25519 recipient. Only the public recipient is on the host. The recovery identity stays on the approved Mac with mode 0600. Do not generate a post-quantum identity: the installed host age 1.1.1 must read this recipient; the Mac age 1.3.2 default X25519 identity is compatible.
- An hourly Mac pull over the existing authenticated SSH route. It verifies the transferred ciphertext checksum, decrypts into a new private temporary directory, loads SQLite, checks integrity and foreign keys, validates the manifest's schema (6 or later, including additive schema 7), tests the signing key, decrypts every saved SSH key and derives its public key for comparison. It never starts Service, migrates the snapshot, contacts providers or charges payments.
- Restore tar accepts exactly six regular top-level files. Links, path traversal, duplicates and extensions are rejected before writing extracted files. Plaintext temporary files are removed on normal success/failure. Encrypted copies and checksum/verification metadata remain.
- Host retention: 14 newest completed archives plus the last verified restore if older, at most 512 MiB. Mac retention: 30 archives, at most 1 GiB. Each archive is limited to 64 MiB. The newest archive and last verified restore are never pruned. Unknown files and historical deployment backups are untouched. Increase the reviewed limits when the database approaches this bound.
- Every two minutes, the monitor checks exact container ID, image ID, Compose ownership labels, data mount, internal health and public health. Three consecutive internal failures **and** Docker `unhealthy` permit one restart of that exact container ID. Maximum two attempts per 24 hours and a 30-minute cooldown. Healthy, stopped, missing, mismatched or maintenance services are never restarted; public-proxy failures do not restart the app. Recovery checks internal/public health again.
- A read-only SQLite check reports orders awaiting a refund, provisioning over 30 minutes, deletion needing review, and an OpenStrudel production account without a valid API key. These are operator alerts and never trigger process restarts.
- Backup older than 36 hours or a Mac restore confirmation older than 48 hours makes the monitor fail visibly in systemd. Logs contain status codes and archive identifiers, not customer records or secret values. There is no email or Telegram sending.

Both host jobs hold the existing `/srv/wai-vds/deploy.lock`. This prevents overlap with deployment. Helper Node containers use the already installed image ID, `--pull never`, no network, no Docker socket, read-only root filesystem and bounded memory/PIDs. The host does not need Node. Backup helpers mount only this app's data/configuration and their own output directory; monitor helpers consume sanitized JSON over stdin.

## Review and install

Prerequisites are already inspected: Docker, Python, GNU tar, flock and OpenSSL exist on the host; age has been installed separately by the parent task. Mac needs Node 24+, `age`, `age-keygen`, `ssh-keygen`, SSH/scp and Python. Test locally:

```sh
node --test tests/production-ops.test.mjs
bash -n deployment/operations-{backup,monitor,pull-mac,install}.sh
```

The reviewed `deployment/pack.sh` includes `operations-*` in the release bundle. Preserve either layout: `deploy/operations-install.sh` beside `app/scripts/production-*.mjs`, or `deployment/` beside `scripts/`.

On the Mac, create the identity only if it does not exist. Keep an additional user-controlled recovery copy of that identity when such a destination is explicitly approved; no new cloud storage is configured here. Without the identity the encrypted archives cannot be recovered.

```sh
umask 077
backup_root="$HOME/Library/Application Support/WAI VDS"
mkdir -p "$backup_root/backup-keys" "$backup_root/operations" "$backup_root/logs"
chmod 700 "$backup_root/backup-keys" "$backup_root/operations"
test -f "$backup_root/backup-keys/production.agekey" || age-keygen -o "$backup_root/backup-keys/production.agekey"
chmod 600 "$backup_root/backup-keys/production.agekey"
age-keygen -y "$backup_root/backup-keys/production.agekey" > "$backup_root/backup-keys/production.recipient"
chmod 600 "$backup_root/backup-keys/production.recipient"
```

Transfer **only** `production.recipient` to a new root-owned 0600 file on the documented host. Review the installer and invoke `operations-install.sh /path/to/production.recipient`. It refuses recipient rotation, installs only its two new service/timer pairs and enables the timers. It does not restart the application. Before considering installation accepted, run one backup manually and inspect the JSON result:

```sh
/srv/wai-vds/operations/operations-backup.sh
systemctl list-timers 'wai-vds-operations-*'
```

On the Mac, copy `scripts/production-backup.mjs` and `deployment/operations-pull-mac.sh` into `$backup_root/operations` with mode 0500. Run the copied pull script once. It prints `restore_verified:true` only after a real decrypt and restore check and after the host has recorded the same ciphertext digest as verified.

Then review/copy `operations-mac.plist` to `~/Library/LaunchAgents/is.wai-vds.production-backup-pull.plist`, validate it with `plutil -lint`, and bootstrap **only this new label** in `gui/$(id -u)`. The template is specific to the approved Mac user and does not modify `is.wai-vds.local` or OpenStrudel. If updating this pull agent later, wait for its old PID to exit before bounded bootstrap retries. Do not restart an unchanged agent.

Finally run `/srv/wai-vds/operations/operations-monitor.sh`. Expected result after the first verified Mac pull: `{"action":"none","reason":"healthy"}`. Check `journalctl -u wai-vds-operations-backup -u wai-vds-operations-monitor` and the two Mac backup logs. A failed unit or failed Mac pull requires investigation; there is no external notification integration in this package.

## Recovery and maintenance

Create `/srv/wai-vds/operations/maintenance` before intentional maintenance; remove it when finished. This prevents monitor recovery. Deployments already exclude the monitor through `deploy.lock`.

Verification restores only into new temporary directories. A real production restore is a separate reviewed operation: retain the current database and configuration, account for payments received after the snapshot, stop only the owned service, restore the chosen verified SQLite/keys/env together, preserve permissions/ownership and validate application health before resuming. Never restore an older database automatically over newer payment records.

After a machine crash or SIGKILL, inspect and remove only stale private `operations/tmp/snapshot.*`, `production-encrypted/.restore.*` and the Mac `.pull.lock` when no corresponding job is running. Normal EXIT cleanup handles ordinary failures. The identity is not included in the encrypted archive; existing master/bootstrap keys are included and never rotated by the backup job.

## Verified locally

The tests exercise committed WAL data, additive schema 7, independent snapshot contents, real age encrypt/decrypt, actual SSH-key recovery, damaged ciphertext/master keys, tar traversal rejection, bounded retention preserving a known restore, ownership fencing, transient failures, restart cooldown/daily budget, backwards clock and stale backup reporting. The age integration test explicitly skips only when the reviewed binary is absent. Host timers and the Mac pull agent are installed. Real schema-7 backup/decrypt/restore and healthy monitoring are recorded in outputs/production-readiness.json. No destructive host recovery was simulated on production.
