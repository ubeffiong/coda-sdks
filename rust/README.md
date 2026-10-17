# coda-client

Rust client for the CODA clinical terminology API. Blocking, built on `ureq` and `serde_json`; Rust 1.70+.

Part of [CODA](https://github.com/ubeffiong/coda-sdks), clinical terminology intelligence: search, validation, value sets, mappings and an AI coding assistant across ICD-11, SNOMED CT, LOINC, RxNorm and more.

## Install

```bash
cargo add coda-client
```

## Quick start

```rust
use coda_client::{Client, CodingItem, SystemRef};

let coda = Client::new("https://coda.example.org", &std::env::var("CODA_TOKEN")?);
let results = coda.search("type 2 diabetes with nephropathy", &[SystemRef::new("http://id.who.int/icd/release/11/mms")], Some(5))?;
```

Use `Client::with_token_provider` to refresh tokens, and `.max_retries(n)` / `.timeout(d)` to tune behaviour.

## Verify a webhook

```rust
let ok = coda_client::verify_webhook(&secret, &id, &timestamp, &signature, &raw_body, now_unix, 300);
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
- Integration guide: [docs/EMR-INTEGRATION.md](https://github.com/ubeffiong/coda-sdks/blob/main/docs/EMR-INTEGRATION.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Licence: [Apache-2.0](LICENSE)
