# CODA client SDKs

Thin, dependency-light clients for the CODA terminology API (v1) in six languages. They all implement the same contract, so behaviour is the same whichever language an integrator uses.

| Language | Folder | Package name | Runtime deps |
|---|---|---|---|
| C# / .NET 8+ | [`dotnet/`](dotnet) | `Coda.Client` | none (BCL `HttpClient`, `System.Text.Json`) |
| TypeScript / JavaScript (Node 18+, browsers) | [`typescript/`](typescript) | `@coda/client` | none (`fetch`) |
| Python 3.9+ | [`python/`](python) | `coda-client` | none (standard library `urllib`) |
| Java 17+ | [`java/`](java) | `org.coda:coda-client` | Jackson Databind |
| Go 1.21+ | [`go/`](go) | `github.com/ubeffiong/coda/sdks/go` | none (standard library) |
| Rust 1.70+ | [`rust/`](rust) | `coda-client` | `ureq`, `serde`, `serde_json` |

## Contract

**Construction**
- A base URL (e.g. `https://coda.example.org`).
- A token provider: a static bearer token or a callback, called before each request so tokens can be refreshed.
- Optional: a timeout (default 30 s) and `maxRetries` (default 2).

**Operations.** Names are adapted to each language's conventions.

| Operation | HTTP | Notes |
|---|---|---|
| `systems()` | `GET /api/v1/systems` | Systems, releases, capabilities |
| `lookup(system, code, version?)` | `GET /api/v1/concepts/lookup` | Exact concept in a resolved release |
| `search(query, systems[], count?, includeInactive?)` | `POST /api/v1/search` | POST keeps clinical text out of URLs |
| `validate(system, code, version?, display?, valueSetUrl?)` | `POST /api/v1/codes/validate` | `valid / inactive / invalid / unknown / unsupported` |
| `validateBatch(items[])` | `POST /api/v1/codes/validate-batch` | Up to 500 codings, with a quality summary |
| `validateFhir(resourceJson, valueSet?)` | `POST /api/v1/codes/validate-fhir` | Every Coding in a FHIR resource or Bundle |
| `expand(valueSet, filter?, offset?, count?)` | `POST /api/v1/expand` | Value set by key or canonical URL |
| `translate(system, code)` | `POST /api/v1/translate` | Approved local mappings only |
| `analyzePhrase(phrase, systems[])` | `POST /api/v1/phrases/analyze` | Grounded suggestions; always needs human review |
| `recordDecision(request, idempotencyKey)` | `POST /api/v1/decisions` | Requires an `Idempotency-Key`; replays are safe |

**Behaviour, identical in every SDK**
1. Every request sends `Authorization: Bearer …`, `Accept: application/json` and a fresh `X-Request-Id`.
2. Non-2xx responses raise or return a `CodaApiError`. It carries `status`, the stable `code` (e.g. `RATE_LIMITED`, `UNKNOWN_CODE_SYSTEM`), `detail`, `correlationId` and `retryable`, all taken from the RFC 7807 body.
3. **Retries:**
   - What is retried: up to `maxRetries` retries after a 429 or 503, or after a network failure. The wait honours `Retry-After`, capped at 10 s, with exponential backoff otherwise.
   - Why it is safe: every operation is either read-only (POST is used only to keep text out of URLs) or idempotent by `Idempotency-Key`.
   - What is not retried: other 4xx responses.
4. Responses are returned as JSON-shaped objects with the API's field names (camelCase, kebab-case enum values). The SDKs never reinterpret outcomes, so `unknown` is never turned into `invalid`.
5. Clinical text is never logged by the SDKs.

## Testing

Each SDK has unit tests against a local mock HTTP server or handler. They cover:
- request shape
- error mapping
- retry with `Retry-After`
- giving up on non-retryable errors

`sdks/smoke.sh` runs every SDK's example against a live CODA (e.g. the docker-compose stack).
