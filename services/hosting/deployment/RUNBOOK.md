> Current production is https://server.waiwai.is, release v9. See PRODUCTION.md. The first-install steps below are historical; do not rerun them against the installed service. Legacy /vds compatibility was declined by the user.

# Historical installation runbook

**Current production state and v6 launch procedure: [PRODUCTION.md](PRODUCTION.md).** This document records the first v3/v4 deployment with checkout closed; it is not the current sales state. Do not rerun the initial App installer against existing credentials.

# WAI VDS on the existing wai-pay host

Upgraded 2026-10-05: release `20261005-vds-v4`, public URL `https://pay.waiwai.is/vds/`, container healthy, live checkout locked. Upgrade backup `/srv/wai-vds/backups/20261005T102637Z`. The initial installation backup remains `/srv/wai-vds/backups/20261004T204255Z`. Target is the documented wai-pay host `root@103.45.247.25`; no extra server or DNS record is needed. Existing wai-pay Apps, keys, payments and provider accounts are unchanged; only the separate `wai-vds` App was added. Existing backend/database/admin containers were not restarted.

## Verified topology and capacity

- Current repo `/srv/wai-pay/app`, compose `/srv/wai-pay/app/docker-compose.yml`.
- Containers `waipay-caddy`, `waipay-backend`, `waipay-admin-ui`, `waipay-postgres`.
- Shared Docker bridge is **`app_waipay`**, not `waipay`.
- Caddy binds `/srv/wai-pay/app/Caddyfile` to `/etc/caddy/Caddyfile:ro` as a single file.
- Existing named volumes `app_caddy-data`, `app_caddy-config`; PostgreSQL bind `./pgdata`.
- Host Linux amd64, 2 GiB RAM; inspection found 1.2 GiB available RAM and 4.5 GiB free disk.
- New service uses 256 MiB maximum RAM, 0.5 CPU, 64 PIDs, its own `/srv/wai-vds/data` volume, no host port and no Docker socket.
- Base URL `https://pay.waiwai.is/vds`; callback `https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay`.
- `handle /vds/*` preserves the prefix. The app's configured base path handles routes/assets/cookies/return URLs. `/vds` redirects to `/vds/`.

The root Caddy source's unrelated behavior is retained exactly. Source baseline SHA256 is `c3e872c7c0fb54d14e7c7cf963e8c465940271dc743d01018fb3395cce1c6387`. Any later source/runtime drift aborts the script and requires a fresh review.

## Dedicated payment App (installed)

Create only a new App `wai-vds`, name `WAI VDS`, callback as above. Defaults are `STRIPE: stripe-main` and `CRYPTOMUS: cryptomus-main`. Explicit mode is `LIVE`, scopes exactly `payments:v2`. Do not reuse another App's key or callback secret.

The existing admin POST `/admin/api/apps` accepts id/name/callbackUrl/defaultProviderAccounts and returns the new API key and webhook secret once. It does **not** accept mode/scopes. `register-app.sh` handles this in two phases: create through that API, durably save the new pair to `/srv/wai-vds/app-credentials.env` as root:0600, then verify that pair against the exact new App and narrowly set `mode=LIVE` and `apiScopes=[payments:v2]`. It checks authentication with a GET for a nonexistent external payment, which creates no invoice. Existing App or credential file aborts without rotation or overwrite.

Run the prepared wrapper on the documented host after final review: `bash /srv/wai-vds/releases/RELEASE_ID/deploy/register-app.sh`. The admin password is read only inside the already configured backend process environment. Its response is captured in host memory and never printed. The operator then merges the two new WAI Pay lines from the root-only credential file into `/srv/wai-vds/runtime.env`, along with the explicitly authorized Kamatera pair and reviewed nonsecret template settings. Do not print secret values, retain provider-wide credentials in wai-pay, and do not copy other Apps' keys. The wrapper's ordinary rerun always aborts. If creation has an unknown outcome, inspect the exact App first; if scope activation fails, the already-saved pair remains available for controlled recovery without rotation.

Stripe LIVE and TEST read-only account/status/balance checks passed. Cryptomus LIVE balance/status checks passed, but its database had no successful payment; a real crypto settlement has not been verified. The integration accepts USD/EUR for Stripe, USDT for Cryptomus, RUB for TBank. It performs no FX conversion. 1200 means USD 12.00 or USDT 12.00. TBank stays disabled: no approved RUB price or merchant selection.

All three existing active TBank accounts have a syntactically valid v2 service/prepayment receipt configuration. Request description becomes the one receipt line, capped at 128 characters. The code permits sharing an active account of the matching mode across Apps. Merchant contractual scope and VDS tax treatment are not recorded in this repository, so existing educational account settings do not prove suitability for VDS.

## First installation sequence

1. Run the complete app checks locally. `bash deployment/pack.sh RELEASE_ID` packages only source/public/scripts/tests/package.json and these deployment files. It excludes `.env`, `work/runtime`, all existing keys, logs, SQLite databases and Kamatera credentials. Review the archive checksum and contents.
2. Upload to a new `/srv/wai-vds/releases/RELEASE_ID/` on the documented server. Verify the checksum. The extracted `app/` contains the immutable build context; `deploy/` contains this bundle. Do not run wai-pay's broad `docker compose up`.
3. Create the dedicated payment App as described above; write `runtime.env` securely from the template. **Keep `WAI_ALLOW_PAID_VM` empty and `WAI_MAX_PROVIDER_MONTHLY_USD=0`.** Use `WAI_PROVIDER=kamatera`, `WAI_PAYMENTS=wai_pay`, mode LIVE. Approval for the isolated pilot does not open public checkout or authorize recurring customer infrastructure.
4. Review `diff -u /srv/wai-pay/app/Caddyfile RELEASE/deploy/Caddyfile.after`, the independent compose, and the release checksum. Execute `bash /srv/wai-vds/releases/RELEASE_ID/deploy/apply-first.sh RELEASE_ID`.
5. The script locks its own deployment, rejects existing data/container or source drift, validates permissions and no-spend settings, checks disk, builds a pinned official Node 24 image, and runs all tests with two workers. No `npm install` or production dependency download is needed beyond the base image and system SSH/CA packages. The reviewed image is Ubuntu 26.04 `EU:7a74bdc0c8034ce9a1fd28d8ed91f8f5`; no VM is created by deployment.
6. It makes a timestamped root-only backup of Caddy source, Caddy active JSON and WAI VDS runtime env; validates candidate Caddy configuration; checks existing wai-pay health; starts only `wai-vds`; checks container health; atomically replaces the host Caddyfile; and loads it with `caddy reload` through stdin.
7. Public checks cover WAI VDS health, catalog with `checkout_enabled=false`, HTML, OpenAPI server URL `https://pay.waiwai.is/vds/api/v1`, and unchanged wai-pay health. Root should additionally inspect the browser at `/vds/`, assets and API descriptions, test unsigned callback rejection, and verify no provider VM or live invoice was created.

## Why Caddy reload uses stdin

Atomic rename of a bind-mounted single file changes the host inode. A running container's mount may retain the old inode. Therefore never run `caddy reload --config /etc/caddy/Caddyfile` after this first atomic install. The script uses:

```sh
docker exec -i waipay-caddy caddy reload --config - --adapter caddyfile < /srv/wai-pay/app/Caddyfile
```

The runtime switch is atomic, and the host source is correct for future container starts. Future reloads must keep using the host source through stdin until Caddy is recreated for a separately reviewed reason. This deployment needs no restart of wai-pay backend, database, admin UI, or Caddy.

## Rollback and data

On post-start failure the first-install script restores the saved host Caddyfile atomically, reloads the exact saved Caddy JSON through stdin, stops only the new WAI VDS container, checks wai-pay health and preserves all WAI VDS data. It never deletes volumes or payment history and never rotates/revokes an App key. Check the rollback command results; if health remains unhealthy, use the saved exact configuration and diagnose before retrying.

The WAI VDS SQLite file, WAL, master encryption key and signing key live together in `/srv/wai-vds/data`, owner 1000:1000, mode 0700. Future upgrades require an application-consistent SQLite backup plus both keys and an explicit migration rollback plan. `apply-first.sh` normally refuses an existing database/container. Its explicit `--recover-stopped-first` option only permits an exited container with the exact WAI VDS compose labels, no successful current-release marker, and either no database or an intact schema-v6 LIVE database with every business table empty. It backs up SQLite and both keys before recovery. This is not a general upgrade command.

## Compatible code upgrades

`upgrade.sh RELEASE_ID` upgrades only the existing `wai-vds` container on this documented host. Package and upload a new immutable release directory first. The script verifies the running release and image ID, exact Compose labels, unchanged storage schema, root-only env and closed spending gate. The build runs the complete suite, including four regressions using the real OpenSSH parser. The final runtime image does not contain the SSH server used by those tests. All 141 tests passed on Mac and Linux, without skips; eight external HTTP checks passed after the upgrade. Evidence: `outputs/upgrade-checks.json`.

Before applying, it creates a timestamped backup of the runtime env, previous Compose file, release marker, an online SQLite backup and both encryption/signing keys. It starts the exact service, checks the new immutable image ID and health, public WAI VDS health, `checkout_enabled=false`, and existing wai-pay health, then atomically advances `current-release`. Caddy and wai-pay containers are untouched.

On failure it reinstalls the previous image and verifies its exact image ID, labels, health and public endpoints before reporting successful rollback. The current database is retained; compatible rollback never restores an older database over newer records. Schema changes require a separate migration and rollback procedure. Local shell fault tests cover a failed Compose rollback, a healthy wrong image and a verified rollback.

Release `20261005-vds-v4` fixes a live-pilot finding: the Kamatera Ubuntu image omitted `Include` in the primary SSH configuration, so a drop-in alone did not disable passwords. The bootstrap now validates and atomically installs its policy at the beginning of the primary file, checks effective settings and the current root connection, and restores the previous file if reload fails. A repeated identical setup does not reload SSH.

## Live pilot and remaining acceptance limits

- On 2026-10-05, one user-approved Kamatera VM passed creation, signed setup, downloaded-key SSH, all three templates, external HTTP, installed OpenStrudel client access and key revocation, reboot, data export/restore and deletion. The original 17 VM IDs and names were preserved. See `outputs/live-pilot.json`.
- The pilot used a separate private local database and a simulated customer payment. Its budget was capped by the approved $10 scope; the verified base profile was $6/month, with a known 2% administration fee. After deletion, account usage reported $0.001810 across three closed server/network rows. This is not the final invoice: tax, administration fee and rounding remain unverified. No public spend gate was opened.
- No real customer card charge or crypto transfer has been performed. API connectivity does not establish bank or blockchain settlement.
- Callback creation requires a public URL in wai-pay v2; polling alone cannot replace a missing configured callback. GET returns a stored snapshot; POST `/:id/sync` reads provider state and updates that snapshot without charging.
- The deployment accepts customer payments only after the separate VM spend gate is opened. Until then, the catalog explains availability and refuses checkout.
- Customer payment acceptance still requires an appropriate real payment arrangement and approved merchant, price, tax and reseller terms, cost controls, account recovery and external backups.

## Verified first-install recovery

The first run found source files unreadable under UID 1000 because packaging used umask 077. COPY now sets node ownership and a build smoke check imports/reads source after USER 1000. The second run found Node 24 fetch did not send the overridden Host required by the app; the healthcheck now uses node:http and was verified with HTTP 200. Both runs rolled back before exposing VDS and preserved data. The third run passed container and public checks. Source release archive SHA256: `16d62a5b4109bb8ae91a8466d28a618a9c5bd2af3e91f7d67b0ca2c067a19ec0`.

Verified v4 release archive SHA256: `ed0de095f28b125242e9335f69461d4556ad74ed0c0ea5835a134ded65cb4aed`. The deployed image ID is `sha256:019db6ef9ce7471496b1392c4b61ad4d383edf79185557f629982cee5e4dda17`. Existing wai-pay containers retain their 2026-08-27 start times.

## Home preview, схема 8

Для перехода с `20261005-vds-v9` использовать `home-upgrade.py NEW_RELEASE`, не исторические upgrade/ui/domain скрипты. Перед применением — Linux suite в image build, согласованный snapshot SQLite и `scripts/check-migration.mjs`. Сохраняются все старые колонки и строки. Ключи и каталог standalone не меняются; добавляются только WAI_HOME_IMAGE, WAI_HOME_AMOUNT_MINOR=0, WAI_HOME_LIVE_APPROVAL пусто. На ошибке возвращается предыдущий образ/env с текущей БД. Публикация preview не открывает Home checkout. Полный контракт/границы проверки/следующие шаги: `docs/OPENSTRUDEL.md`.
