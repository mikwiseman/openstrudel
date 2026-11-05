# Native Gmail push

Gmail sends a mailbox history watermark through an authenticated Google Pub/Sub subscription. Home verifies Google's signature, issuer, audience and exact service-account email, then checks the configured subscription and mailbox. It commits a notification receipt before returning HTTP 202. No email bodies enter the webhook.

The adapter reads incremental history and minimal message references with `gmail.metadata`. It forwards incoming messages, sent replies and relevant deletion/archive changes to the existing correspondence queue. Draft-only changes, read flags and repeated deliveries do not run the model. The existing Gmail tools, scoped personal/company sources and correspondence skill handle thread context, native drafts and private calendar copies.

## Deployment

Use an existing Google project and its OAuth client. Authorize the owner mailbox with **only** `https://www.googleapis.com/auth/gmail.metadata`, offline access and PKCE. Keep the refresh token in 1Password and the Home's private configuration, never in a model prompt, repository, container image or log.

1. Create a dedicated Pub/Sub topic. Grant `roles/pubsub.publisher` on this topic to `gmail-api-push@system.gserviceaccount.com`.
2. Create a keyless service account with no project roles for push identity. Google's existing Pub/Sub service agent must be able to mint its OIDC token.
3. Create a push subscription to the existing `/hooks/correspondence/<sourceId>` route. Configure the exact endpoint as its OIDC audience and the dedicated service account as its identity. Keep retries and seven-day message retention enabled.
4. Put this JSON in a mode-0600 file owned by the Home runtime user. Set `OPENSTRUDEL_GMAIL_PUSH_CONFIG` to its absolute path. The existing correspondence configuration must authorize the same Gmail source, mailbox and internal source token.

```json
{
  "sourceId": "gmail-mik",
  "sourceToken": "<existing private correspondence source credential>",
  "mailbox": "hi@mikwiseman.com",
  "clientId": "<OAuth client in the same project as the topic>",
  "clientSecret": "<private>",
  "refreshToken": "<metadata-only grant>",
  "topic": "projects/<project>/topics/openstrudel-gmail",
  "subscription": "projects/<project>/subscriptions/openstrudel-gmail-home",
  "pushServiceAccount": "openstrudel-gmail-push@<project>.iam.gserviceaccount.com",
  "audience": "https://<Home domain>/hooks/correspondence/gmail-mik"
}
```

When this adapter is configured, that source's public route accepts only Google OIDC, not the internal bearer or Unipile signatures. Other source routes are unchanged. The isolated hook listener still exposes no Home management API.

5. Drain active work, take the existing managed rollback snapshot, deploy, and verify the owner-only `GET /v1/correspondence` response's `gmailPush` field. Confirm the returned mailbox and watch expiration, a real Google notification receipt, the advanced cursor, and the resulting correspondence run/provider readback. Keep the old drafting task enabled until the replacement is verified, then disable it and read back its state. Preserve existing human/unknown drafts.

## Renewal and recovery

Home renews the watch on startup and once per day. It checks that the OAuth mailbox matches the configured owner before calling `watch`. The first cursor is established before watch registration, so changes between those calls remain recoverable. Renewal does not reset an existing cursor: its returned watermark also catches dropped notifications. This is subscription maintenance, not a periodic inbox scan.

SQLite stores the cursor, renewal deadline, notification receipts and recovery state. History pagination completes before advancing the cursor. If a page or process fails, already accepted source event IDs deduplicate the retry. A notification received during history processing retains its newer watermark. OAuth/network failures retain the cursor and retry after a minute; raw provider errors and tokens are not logged.

An expired history cursor (HTTP 404) sets `recoveryRequired` and stops automatic history processing. It never silently jumps to the present or drafts from an incomplete mailbox. Recovery requires an explicit bounded mailbox reconciliation against existing draft/calendar receipts, followed by an operator checkpoint of the verified current cursor. Keep the pending notification receipts until reconciliation is complete. Changing the configured mailbox, topic, subscription, client or push identity also requires reconciling the existing cursor; credential rotation alone retains it.

Rollback uses the existing Home release and managed backup. Do not remove the Pub/Sub topic/subscription or stop the watch during a short rollback: Google retains unacknowledged pushes for redelivery. If the former Gmail writer is re-enabled, first pause the new source and reconcile pending/uncertain actions to avoid two writers.

References: [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push), [history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).
