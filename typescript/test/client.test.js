import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CodaClient, CodaApiError } from '../dist/index.js';

/** Local HTTP server replaying scripted responses and recording requests. */
async function mock(script) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, json, headers = {}] = script.shift();
      res.writeHead(status, { 'Content-Type': status < 400 ? 'application/json' : 'application/problem+json', ...headers });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { requests, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('search posts the query with auth and a request id', async () => {
  const m = await mock([[200, { requestId: 'r1', groups: [], warnings: [] }]]);
  const client = new CodaClient({ baseUrl: m.url + '/', token: async () => 'tok-1' });
  const r = await client.search('type 2 diabetes', [{ system: 'urn:coda:fixture:clinical' }], { count: 5 });
  assert.equal(r.requestId, 'r1');
  const req = m.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/api/v1/search');
  assert.equal(req.headers.authorization, 'Bearer tok-1');
  assert.ok(req.headers['x-request-id']);
  assert.deepEqual(JSON.parse(req.body), { query: 'type 2 diabetes', systems: [{ system: 'urn:coda:fixture:clinical' }], count: 5 });
  await m.close();
});

test('lookup encodes query parameters', async () => {
  const m = await mock([[200, { code: '1A00' }]]);
  await new CodaClient({ baseUrl: m.url, token: 't' }).lookup('http://id.who.int/icd/release/11/mms', '1A00', '2025-01');
  assert.equal(m.requests[0].url, '/api/v1/concepts/lookup?system=http%3A%2F%2Fid.who.int%2Ficd%2Frelease%2F11%2Fmms&code=1A00&version=2025-01');
  await m.close();
});

test('problems become CodaApiError without retrying client errors', async () => {
  const m = await mock([[422, { code: 'UNKNOWN_CODE_SYSTEM', detail: 'not registered', correlationId: 'c-1', retryable: false }]]);
  const err = await new CodaClient({ baseUrl: m.url, token: 't' }).validate('urn:nope', 'X').catch((e) => e);
  assert.ok(err instanceof CodaApiError);
  assert.deepEqual([err.status, err.code, err.correlationId, err.retryable], [422, 'UNKNOWN_CODE_SYSTEM', 'c-1', false]);
  assert.equal(m.requests.length, 1);
  await m.close();
});

test('429 is retried after Retry-After with the same request id', async () => {
  const m = await mock([[429, { code: 'RATE_LIMITED', retryable: true }, { 'Retry-After': '0' }], [200, { outcome: 'valid' }]]);
  const r = await new CodaClient({ baseUrl: m.url, token: 't' }).validate('urn:coda:fixture:clinical', 'FX-111200');
  assert.equal(r.outcome, 'valid');
  assert.equal(m.requests.length, 2);
  assert.equal(m.requests[0].headers['x-request-id'], m.requests[1].headers['x-request-id']);
  await m.close();
});

test('gives up after maxRetries', async () => {
  const down = [503, { code: 'TERMINOLOGY_PROVIDER_UNAVAILABLE', retryable: true }, { 'Retry-After': '0' }];
  const m = await mock([down, down]);
  const err = await new CodaClient({ baseUrl: m.url, token: 't', maxRetries: 1 }).systems().catch((e) => e);
  assert.equal(err.code, 'TERMINOLOGY_PROVIDER_UNAVAILABLE');
  assert.equal(m.requests.length, 2);
  await m.close();
});

test('FHIR resources are sent as application/fhir+json; decisions carry the idempotency key', async () => {
  const m = await mock([[200, { summary: { total: 0 } }], [201, { id: 'd1' }]]);
  const client = new CodaClient({ baseUrl: m.url, token: 't' });
  await client.validateFhir({ resourceType: 'Bundle', type: 'collection', entry: [] }, 'idsr-immediate');
  await client.recordDecision({ purpose: 'diagnosis', outcome: 'approved' }, 'idem-42');
  assert.equal(m.requests[0].headers['content-type'], 'application/fhir+json');
  assert.equal(m.requests[0].url, '/api/v1/codes/validate-fhir?valueSet=idsr-immediate');
  assert.equal(m.requests[1].headers['idempotency-key'], 'idem-42');
  await m.close();
});

import { verifyWebhook } from '../dist/index.js';

const VECTOR = {
  secret: 'whsec_Y29kYS10ZXN0LXdlYmhvb2stc2VjcmV0LTMyYnl0ZXM=',
  headers: {
    'webhook-id': '0198f1a2-0000-7000-8000-000000000001',
    'webhook-timestamp': '1792100000',
    'webhook-signature': 'v0,old v1,iBHZWsokVTH0FJlTSGXVgcKqbLZN1NklHSqCNCG733Q=',
  },
  body: '{"id":"0198f1a2-0000-7000-8000-000000000001","type":"webhook.ping","data":{"message":"CODA webhook test"}}',
};

test('verifyWebhook accepts the shared vector and rejects tampering, replay and wrong secrets', async () => {
  const at = { nowSeconds: 1792100000 };
  assert.equal(await verifyWebhook(VECTOR.secret, VECTOR.headers, VECTOR.body, at), true);
  assert.equal(await verifyWebhook(VECTOR.secret, new Headers(VECTOR.headers), VECTOR.body, at), true);
  assert.equal(await verifyWebhook(VECTOR.secret, VECTOR.headers, VECTOR.body + ' ', at), false);
  assert.equal(await verifyWebhook(VECTOR.secret, VECTOR.headers, VECTOR.body, { nowSeconds: 1792100000 + 600 }), false);
  assert.equal(await verifyWebhook('whsec_' + Buffer.alloc(32, 1).toString('base64'), VECTOR.headers, VECTOR.body, at), false);
});

test('opens a Connect session with an integration key and launches the clinician', async () => {
  const m = await mock([
    [201, { id: 's-1', status: 'open', launchUrl: 'https://coda.test/connect?session=s-1&launch=coda_lc_x', result: null }],
    [200, { id: 's-1', status: 'completed', launchUrl: null, result: { selections: [{ code: '5A11' }] } }],
  ]);
  const client = new CodaClient({ baseUrl: m.url, token: 'coda_sk_integration-key' });
  const s = await client.openConnectSession({
    appId: 'app-1', text: 'type 2 diabetes', patientRef: 'pt_3f2b8c1e', clinician: { ref: 'usr_7c1d2e9a', name: 'Dr A. Bello' },
  });
  assert.match(s.launchUrl, /launch=coda_lc_/);
  const done = await client.getConnectSession('s-1');
  assert.equal(done.result.selections[0].code, '5A11');

  const [open, get] = m.requests;
  assert.equal(open.headers.authorization, 'Bearer coda_sk_integration-key');
  assert.deepEqual([open.method, open.url], ['POST', '/api/v1/connect/sessions']);
  assert.deepEqual(JSON.parse(open.body), { appId: 'app-1', text: 'type 2 diabetes', patientRef: 'pt_3f2b8c1e', clinician: { ref: 'usr_7c1d2e9a', name: 'Dr A. Bello' } });
  assert.deepEqual([get.method, get.url], ['GET', '/api/v1/connect/sessions/s-1']);
  await m.close();
});
