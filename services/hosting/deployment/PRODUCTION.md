# Production: 5 October 2026

Service: https://server.waiwai.is/ · operator WaiWai, LLC · support hi@waiwai.is.
Documented host: `root@103.45.247.25`, exact Compose project/service `wai-vds`, current release `20261005-vds-v12`, SQLite schema 9. The service has no published Docker port, runs as UID 1000 with a read-only root, 256 MiB RAM and 0.5 CPU. Caddy provides HTTPS.

## Magic Link current v12

Final polish installed 20:02 UTC (23:02 Moscow), image `sha256:a5478db554d2351561bc65afd5c4e00e455f9854c20fa09787a5b1ec10fe72fb`. Backup `/srv/wai-vds/backups/magic-20261005T200243Z`. **268/268 Linux tests**, zero skips/failures. Mail confirmation age is independent of password reauth; the password settings screen asks only for the email proof it accepts. Schema remains 9; all 30 tables were compared without row changes. All 30 deployed source/assets files match the reviewed source. The two LIVE mail flows below were run on v11; v12 retains the same sender, Resend adapter and OAuth contract. No further emails or resources were created by this polish. Fresh encrypted v12 backup `wai-vds-20261005T200411Z-b593c93c.tar.age` was independently restored and verified on Mac (schema 9). Final evidence: `outputs/magic-link-evidence.json`, `magic-link-deployment-v12.json`.

## Magic Link initial v11

Installed 19:56 UTC (22:56 Moscow) on 5 October. Image `sha256:70d32b75bbad6461f70a6999f62ab6d531dedb966b714784cd1a401d0d0f5da4`. Backup `/srv/wai-vds/backups/magic-20261005T195615Z`. Linux Node 24 and Mac suites: **266/266**, zero skips/failures. Schema 8→9 rehearsal preserved every old row/column across 27 tables. Only wai-vds was recreated; catalog, Home spend gates, Caddy, WAI Pay and existing infrastructure/signing keys stayed unchanged.

Resend is enabled with verified sender `WAI Server <login@mail.waiwai.is>`; click/open tracking are off. Web and branded OpenStrudel login now offer email links by default. Links are single-use, ten-minute, browser-bound and require confirmation. PKCE/state/redirect rules remain enforced. Sensitive owner actions accept fresh email confirmation; a verified owner can set an optional password. First verification of a previously unverified email invalidates prior unverified credentials to prevent account pre-hijacking. See `docs/MAGIC-LINK.md` for the exact behavior and internal HTTP contract.

LIVE proof used two documented Resend simulated delivery addresses, both reported delivered. Actual production web sign-in and native PKCE exchange passed; other-browser and replay checks rejected. Test sessions were logged out and native grant revoked. No personal inbox delivery is claimed. Encrypted backup `wai-vds-20261005T195748Z-1113a77d.tar.age` was restored on Mac at 19:58 UTC with schema 9, valid keys, integrity and foreign keys; monitor reported healthy with zero business alerts. No new invoices, VMs or charges were created. Evidence: `outputs/magic-link-evidence.json`, `magic-link-live-proof.json`, `magic-link-deployment.json`.

## OpenStrudel preview v10

Installed 15:54 UTC on 5 October. Image `sha256:c3ba472efc22a8bb5fef2371e54c41fb87ea3615a07c5d81da5a43bcc4d7929d`. Backup `/srv/wai-vds/backups/home-20261005T155405Z`. Linux Node 24 suite: **250/250**, zero skips. Schema 7→8 rehearsal retained every old column and row across 19 tables. Only wai-vds was recreated; Caddy and WAI Pay were unchanged.

Adds public-client PKCE owner auth, immutable 4/30 Home quotes/orders, hosted payment return, independent financial/session/Home states, pinned installer/readiness, owner/grant-bound one-use claim, recovery using the existing Home pairing protocol, renewal/cancellation/root and manual SSH export instructions. Exact contract: `docs/OPENSTRUDEL.md`, `docs/openstrudel-openapi.json`.

**Home purchase stays closed**: WAI_HOME_AMOUNT_MINOR=0, WAI_HOME_LIVE_APPROVAL empty. Confirmed image is EU:6000c29549da189eaef6ea8a31001a34. Free API public estimate $14.28; tax/account price unverified. The standalone $12 2/20 catalog is unchanged. No new invoice, VM, card charge or crypto transfer was created. No real 4/30 Home acceptance or OpenAI sign-in is claimed.

Free production auth proof used one synthetic `example.invalid` owner, proved exact callback/state/issuer, incorrect PKCE rejection, code replay revocation, closed Mac Home checkout and iOS rejection. The synthetic browser session was logged out and native grant revoked. It did not create an order. Foreign-owner isolation uses automated fixtures; the LIVE nonexistent-UUID check is not presented as a foreign-order test.

The Home bootstrap-aware backup verifier was atomically installed on the host and approved Mac. Fresh archive `wai-vds-20261005T155922Z-44538c6c.tar.age`, SHA256 `0539cb7440c72d3c9c62d09975a941d6357c25e04fb2e32720f546153a0b50c8`, was restored and verified on Mac at 16:00 UTC (schema 8, signing key and integrity). Monitor reported healthy and zero business alerts. Local Mac DNS now resolves normally; browser screenshot on the final domain: `outputs/server-domain-production.png`.

Evidence: `outputs/openstrudel-evidence.json`. Historical release evidence below retains its original version numbers. The current preview does not authorize a later Home spend-gate change.

## Domain release v9

The user selected `server.waiwai.is` and explicitly declined legacy API compatibility. Origin, root-path health check, WAI Pay's own App callback and the installed OpenStrudel integration origin were updated. No credentials changed and no invoices/VMs were created. The native Stripe webhook still belongs to WAI Pay on pay.waiwai.is.

Final domain backup: `/srv/wai-vds/backups/domain-20261005T144722Z`. Image: `sha256:7b90c14ef49e1e9ae48939ccd38da2a1e3094320274705bb26c32b80173bdb37`. Evidence: `outputs/domain-v9-deployment.json`, `domain-v9-health.json`, `domain-v9-proxy.json`. The application files are byte-identical to v7; this is a configuration release, schema remains 7.

Caddy's read-only single-file mount retained its old inode after atomic host-file replacement. Reloading stdin changed live routing but would not survive a process restart. The exact `app/caddy` service was therefore recreated with its existing immutable image and volumes; the mounted config now matches the host file. Other WAI Pay services were not recreated. The existing trusted Docker subnet was preserved. The first mount refresh guard expected a narrower CIDR and triggered a verified full rollback; after inspecting the actual configuration, cutover and mount refresh completed. Current database was retained throughout.

`domain-upgrade.py` and `refresh-caddy-mount.py` document this exact cutover, not generic multi-host deployment. Do not re-run a first-install payment registration. Local recursive DNS can retain a prior NXDOMAIN temporarily; public Google/Cloudflare and the production host resolve the correct A record. HTTPS was also verified from Mac using explicit DNS resolution with certificate validation.

## Interface release v7

Frontend-only update installed 14:24 UTC on 5 October. Backend and tests were byte-identical to v6; runtime environment/catalog were unchanged. Backup: `/srv/wai-vds/backups/20261005T142457Z`. Image: `sha256:a9e7c8c261249c9b17ecb2d846411909b944dd6839c367288a1d638a0bd875eb`. Linux build ran 213 tests, all passed with zero skips. Only wai-vds was recreated. Evidence: `outputs/design-v7-deployment.json` and `design-v7-qa.json`.

`ui-upgrade.sh` is restricted to frontend changes: it rejects backend, tests, build-contract and Compose changes, preserves runtime settings and checks the unchanged catalog after application or rollback. It must not be used for domain/configuration or schema upgrades.

## Launch settings

- $12 by card or 12 USDT per 30 days from readiness; renewal requires a new explicit payment.
- `WAI_MAX_LIVE_SERVERS=1` includes active resources, uncertain creation and payable checkout reservations. Renewals use their existing VM slot.
- `WAI_MAX_PROVIDER_MONTHLY_USD=10` compares the current public calculator estimate, including the known 2% administration fee. Current estimate $6.12. It is not a binding quote, final tax-inclusive invoice or account-wide spending limit. No pricing fallback is used when the catalog is unavailable or malformed.
- The exact profile is EU/Amsterdam, approved Ubuntu image, 1A CPU, 2048 MB, 20 GB, one IPv4, t5000 traffic, monthly billing, no provider backup or managed service. Unknown creation is reconciled by exact persisted identity; it is never retried blindly.
- A full refund before a paid create stops provisioning. Refund during an uncertain create preserves its identity and capacity until reconciled. Late payment with no available slot becomes `needs_refund` for the operator.

## Payments

App `wai-vds` is LIVE with only `payments:v2` scope and its own API/webhook credentials. Defaults: Stripe `stripe-vds`, crypto `cryptomus-main`. Dedicated Stripe endpoint: `https://pay.waiwai.is/webhooks/stripe/stripe-vds`, seven checkout/refund events. A new `STRIPE_WAI_VDS` prefix was added to the existing wai-pay environment. Existing provider credentials and other App routing were preserved. Only the documented `backend` Compose service was recreated to load the new prefix; Caddy, PostgreSQL and admin UI were not restarted.

The Stripe installer has a durable idempotent intent and private recovery journal at `/srv/wai-vds/stripe-vds-setup`. Do not run first-install registration again. After any payment exists for stripe-vds, its rollback intentionally refuses to remove the credentials needed for history/reconciliation.

Card proof: one real unpaid $12 hosted session, then native Stripe expiry, real verified event, client callback HTTP 200 and released VDS capacity. Crypto proof: one real unpaid 12 USDT invoice with natural 900-second expiry, actual provider cancellation 115 seconds later, verified webhook, callback HTTP 200 and released capacity. The unopened invoice reported a nullable received amount, not explicit zero; exact evidence is in `outputs/production-crypto-proof.json`. Neither proof sends a fake payment event or transfers money. No actual card settlement, blockchain deposit or merchant payout was performed.

## Closing sales and upgrading

To close checkout on this exact release:

```sh
bash /srv/wai-vds/operations/promote.sh close
```

This also closes the provisioning spend gate; already paid unstarted orders require reconciliation/refund rather than silent creation. Existing running VMs are not deleted. Inspect pending payments first when planning maintenance. The legacy opening preflight is deliberately not reused after this domain change. Reopening requires a fresh review. Do not run `promote.sh open` against an occupied service: its initial launch guards deliberately require no active resources/reservations or unresolved paid orders. A later cap increase/reopening needs an explicit review of current commitments and funds.

Schema 6→7 was rehearsed on an independent online snapshot with every old table's rows compared. Migration backup: `/srv/wai-vds/backups/20261005T130609Z`. Sales-open environment backup: `/srv/wai-vds/backups/promotion-20261005T130737Z`. The v5 candidate stopped before application replacement because its rehearsal helper lacked file-read permission; v6 fixed that and completed. No customer data was rolled back.

For a future release: inspect the full diff, close and reconcile payable work as needed, validate/tests, create timestamped consistent backup, apply atomically, recreate only the exact WAI VDS service, check immutable image/labels/public health and wai-pay health, then update the release marker. On failure restore compatible code/configuration while retaining the current database. Never overwrite newer payment records with an old snapshot.

## Backups and monitoring

`operations-README.md` is the detailed restore runbook. Daily 03:10 UTC encrypted age backups, hourly verified Mac pull, host retention 14 archives/512 MiB and Mac retention 30/1 GiB. A real schema-7 decrypt/restore verified integrity, foreign keys and signing key. Secret recovery identity lives only on the approved Mac; keep a separate user-controlled recovery copy. Backups contain the service database/keys/settings, not customers' VM files.

Every two minutes the exact-service monitor checks ownership, internal/public health, backup freshness and business state. It reports refunds needing an operator, provisioning over 30 minutes, deletion attention and missing valid OpenStrudel access. These business alerts never restart the app. Process recovery is limited to an owned unhealthy container after three failures, at most twice per day. No external email or Telegram notifications were configured.

```sh
systemctl status wai-vds-operations-backup.timer wai-vds-operations-monitor.timer
journalctl -u wai-vds-operations-monitor.service -n 20 --no-pager
docker exec wai-vds node scripts/ops.mjs list
docker exec wai-vds node scripts/preflight.mjs
```

Unknown provider state must be reconciled before a refund-related cleanup or replacement VM. The first SSH host key uses verified provider IP plus TOFU, then pinning. HA, automatic customer-VM backups and automatic money refunds are not claimed.

## OpenStrudel

Installed integration: `~/Library/Application Support/OpenStrudel/runtime/.data/workspace/personal/integrations/wai-vds`.
`client.mjs` retains the local sandbox; `production.mjs` selects the separate live `.env.production` (0600). Live key expires 2026-11-04 13:10 UTC. It reads/manages only its own account, cannot issue keys and cannot use sandbox provisioning in production. Only normal hosted payment can fund creation. Neither daemon nor shared OpenStrudel environment was changed.

## Evidence

`outputs/production-readiness.json`, `production-agent-checks.json`, `production-ui-checks.json`, `production-stripe-proof.json`, `production-crypto-proof.json`, and the historical `live-pilot.json`. Core suite: 213/213 on Mac and Linux Node 24, zero skips. Installer and live-invoice verification scripts have separate mocked safety tests. UI has human/agent modes, recovery, support, terms and privacy explanations; monetary settlement remains explicitly unverified by this setup run.
