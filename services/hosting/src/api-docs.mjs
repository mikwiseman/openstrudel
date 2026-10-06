export function agentGuide(origin) {
  return `# OpenStrudel · Серверы: agent interface

Base URL: ${origin}/api/v1
OpenAPI: ${origin}/openapi.json

Authenticate using Authorization: Bearer <your key>. Keep the key on your backend. Do not put it in URLs, prompts, screenshots or logs. Keys are scoped to one user and environment, expire in at most 30 days, and can be revoked.

## Ordinary flow
1. GET /catalog. Read the actual payment/provider modes and price. Do not infer a live VM from a test response.
2. POST /orders with {"purpose":"agent","payment_method":"card","idempotency_key":"your-stable-request-id","consent":true}. Purposes: agent (Ubuntu + Docker), site (Ubuntu + Nginx), clean (Ubuntu + SSH). Obtain the human's price/period/deletion consent before sending consent:true. Choose payment_method from the catalog (card or crypto in production); the server selects its price and currency.
3. POST /orders/{id}/checkout. Open the returned hosted payment URL for the human. Do not collect card data or claim payment succeeded from a return URL.
4. GET /orders/{id}, then GET /servers/{server_id}. Poll every 5 seconds locally or 15 seconds live. Ready requires completed setup and checks. Respect Retry-After/429; back off on 503. Reuse the same idempotency key after network errors.
5. POST /servers/{id}/access downloads the private SSH key. Store it with mode 0600; never log it. The response includes no-cache headers.
6. POST /servers/{id}/delete with {"confirm":"exact-server-UUID"} only after authorization to destroy that server. Poll until deleted. Turning a server off does not stop billing.

## OpenStrudel sandbox
Only a separately issued key with sandbox:provision may POST /agent/servers with purpose, idempotency_key and consent:true. This endpoint works only when both payments and infrastructure are emulated. It returns 202, server, poll_url, mode:emulator and billable:false. Poll the same normal server endpoint. The reserved 192.0.2.x IP is not reachable and is not a real VM. A real infrastructure test requires the separately approved operator spending configuration.

The sandbox key has an active-server limit. Delete finished tests and wait for deleted before starting more. A repeated idempotency key returns the same order/server even after deletion; use a new key only for an intentionally new test.

## Failure handling
unknown/attention: reconcile, never blindly order a replacement. rejected: explicit retry after the underlying issue is resolved. deleting + operation.delete_attention: /retry requests fresh ownership/power checks and continuation. refunded or error payment_refunded: payment was returned; provisioning is stopped, do not retry creation. needs_refund: contact the operator; do not create another resource as compensation. 401: key expired/revoked; 403: missing scope; 404: absent or foreign resource; 409: conflict or quota; 429: rate limit; 503: transient, safely retry the same operation.

No arbitrary cloud-init or shell scripts are accepted. Customer applications and their credentials are configured by the owner after receiving SSH access. Renewal is an explicit separate order, never an automatic charge.
`;
}

export function openapi(origin) {
  const body = schema => ({ required: true, content: { 'application/json': { schema } } });
  const object = (properties, required = []) => ({ type: 'object', properties, required });
  const string = { type: 'string' };
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const order = object({ purpose: { enum: ['agent', 'site', 'clean'] }, payment_method: { enum: ['card', 'crypto', 'rub', 'test'] }, idempotency_key: { type: 'string', minLength: 8, maxLength: 100 }, consent: { const: true } }, ['purpose', 'idempotency_key', 'consent']);
  const response = (description = 'Successful response') => ({ description, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } });
  const op = (operationId, summary, extra = {}) => ({ operationId, summary, security: [{ bearerAuth: [] }], responses: { '200': response(), '401': response('Invalid or expired key'), '403': response('Missing scope'), '409': response('Conflict or quota'), '429': response('Rate limit'), '503': response('Transient failure; retry with the same idempotency key') }, ...extra });
  return {
    openapi: '3.1.0', info: { title: 'OpenStrudel · Серверы', version: '1.0.0', description: 'User-scoped server lifecycle. Read catalog modes before provisioning. No arbitrary cloud-init. Hosted payment only.' },
    servers: [{ url: origin + '/api/v1' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'User and environment scoped WAI API key. Issued in the human interface; expires within 30 days.' } } },
    paths: {
      '/catalog': { get: op('catalog', 'Read plans, modes and payment availability', { security: [] }) },
      '/me': { get: op('account', 'Read your account, orders and servers') },
      '/orders': { post: op('createOrder', 'Create or reuse an order with explicit price consent', { requestBody: body(order), responses: { '201': response('Order created or reused'), '409': response('Idempotency conflict') } }) },
      '/orders/{id}': { get: op('orderStatus', 'Read order and server ID after verified payment', { parameters: [id] }) },
      '/orders/{id}/checkout': { post: op('checkout', 'Return a hosted payment URL for the human', { parameters: [id], requestBody: body(object({ method: { enum: ['card', 'crypto', 'rub', 'test'] } })) }) },
      '/agent/servers': { post: op('sandboxServer', 'Provision emulated infrastructure using an operator-issued sandbox:provision key', { requestBody: body(order), responses: { '202': response('Emulated server queued; billable=false'), '403': response('Sandbox scope required'), '409': response('Quota or environment mismatch') } }) },
      '/servers/{id}': { get: op('serverStatus', 'Read readiness, IP, SSH command and operation state', { parameters: [id] }) },
      '/servers/{id}/access': { post: op('serverAccess', 'Download the private SSH key; keep it private with file mode 0600', { parameters: [id], responses: { '200': { description: 'OpenSSH private key; no-store', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, '409': response('Access not ready') } }) },
      '/servers/{id}/renewals': { post: op('renewal', 'Create one renewal order with explicit consent', { parameters: [id], requestBody: body(object({ consent: { const: true }, payment_method: { enum: ['card', 'crypto', 'rub', 'test'] } }, ['consent'])) }) },
      '/servers/{id}/cancellation': { post: op('cancellation', 'Cancel at period end or reverse cancellation', { parameters: [id], requestBody: body(object({ cancel_at_end: { type: 'boolean' } }, ['cancel_at_end'])) }) },
      '/servers/{id}/retry': { post: op('retry', 'Request reconciliation or continue a confirmed rejected operation', { parameters: [id], responses: { '202': response('Queued'), '409': response('Operation already running') } }) },
      '/servers/{id}/delete': { post: op('deleteServer', 'Delete the exact server after human authorization; irreversible data loss', { parameters: [id], requestBody: body(object({ confirm: string }, ['confirm'])), responses: { '202': response('Deletion queued; poll until deleted'), '409': response('Current operation needs reconciliation') } }) },
      '/account/export': { get: op('exportAccount', 'Download account metadata without private keys') }
    }
  };
}
