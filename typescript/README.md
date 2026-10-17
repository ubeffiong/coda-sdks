# @coda-terminology/client

TypeScript / JavaScript client for the CODA clinical terminology API. Node 18+ and modern browsers, no runtime dependencies.

Part of [CODA](https://github.com/ubeffiong/coda), clinical terminology intelligence: search, validation, value sets, mappings and an AI coding assistant across ICD-11, SNOMED CT, LOINC, RxNorm and more.

## Install

```bash
npm install @coda-terminology/client
```

## Quick start

```ts
import { CodaClient } from '@coda-terminology/client';

const coda = new CodaClient({
  baseUrl: 'https://coda.example.org',
  token: () => getAccessToken(), // a string, or a function called before each request
});

const results = await coda.search('type 2 diabetes with nephropathy', [{ system: 'http://id.who.int/icd/release/11/mms' }], { count: 5 });
const check = await coda.validate('http://loinc.org', '2345-7', { display: 'Glucose' });
```

Operations: `systems`, `lookup`, `search`, `validate`, `validateBatch`, `validateFhir`, `expand`, `translate`, `analyzePhrase`, `recordDecision` (requires an idempotency key).

## Verify a webhook

```ts
import express from 'express';
import { verifyWebhook } from '@coda-terminology/client';

app.post('/coda/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  const body = req.body.toString('utf8');
  if (!(await verifyWebhook(process.env.CODA_WEBHOOK_SECRET!, req.headers, body))) return res.sendStatus(401);
  const event = JSON.parse(body); // { id, type, timestamp, data }
  res.sendStatus(204);
});
```

## "Search with CODA" in your web pages

`@coda-terminology/client/connect` adds the right-click **Search with CODA** menu and the CODA picker to any web page (the same module CODA serves at `/connect.js`):

```ts
import { CodaConnect } from '@coda-terminology/client/connect';

const connect = new CodaConnect({ codaUrl: 'https://coda.example.org', appId: '<Connect app id>', display: 'modal' });
connect.attachContextMenu(document.body, {
  onSelect: (result, field) => connect.insertInto(field, result.selections[0], 'display-code'),
});
```

## Errors and retries

Every SDK behaves the same way:

- Each request sends `Authorization: Bearer …`, `Accept: application/json` and a fresh `X-Request-Id`.
- A non-2xx response raises a CODA API error carrying `status`, the stable `code` (for example `RATE_LIMITED`), `detail`, `correlationId` and `retryable`, all taken from the RFC 7807 problem body.
- After a 429, a 503 or a network failure the client retries up to `maxRetries` times (default 2), honouring `Retry-After` (capped at 10 s).

## Webhooks

CODA signs webhooks with [Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1,<base64 HMAC-SHA256 of id.timestamp.body>`). Verify the **raw** body exactly as received, reject anything older than five minutes, and de-duplicate on `webhook-id`. The CODA Developer hub has a simulator that generates signed test events.

## Clinical safety

CODA is decision support. Suggestions from `analyzePhrase` always need human review before they are recorded, and a valid code is not proof that it is clinically right for the patient. Do not send patient identifiers in phrases.

## Links

- Developer hub: the key button at the foot of the CODA sidebar (API reference, EMR sandbox, webhook simulator)
- Integration guide: [docs/integration/coda-connect.md](https://github.com/ubeffiong/coda/blob/main/docs/integration/coda-connect.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Licence: [Apache-2.0](LICENSE)
