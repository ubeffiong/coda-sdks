# coda-client

Python client for the CODA clinical terminology API. Python 3.9+, standard library only.

Part of [CODA](https://github.com/ubeffiong/coda), clinical terminology intelligence: search, validation, value sets, mappings and an AI coding assistant across ICD-11, SNOMED CT, LOINC, RxNorm and more.

## Install

```bash
pip install coda-client
```

## Quick start

```python
from coda_client import CodaClient

coda = CodaClient("https://coda.example.org", token=lambda: get_access_token())  # a string or a callable

results = coda.search("type 2 diabetes with nephropathy", ["http://id.who.int/icd/release/11/mms"], count=5)
check = coda.validate("http://loinc.org", "2345-7", display="Glucose")
```

Operations: `systems`, `lookup`, `search`, `validate`, `validate_batch`, `validate_fhir`, `expand`, `translate`, `analyze_phrase`, `record_decision` (requires an idempotency key). Responses are dicts with the API's own field names.

## Verify a webhook

```python
from coda_client import verify_webhook

@app.post("/coda/webhooks")
def coda_webhook(request):
    body = request.body.decode("utf-8")  # the raw body, exactly as received
    if not verify_webhook(os.environ["CODA_WEBHOOK_SECRET"], request.headers, body):
        return Response(status=401)
    event = json.loads(body)  # {id, type, timestamp, data}
    return Response(status=204)
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
