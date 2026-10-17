# github.com/ubeffiong/coda/sdks/go

Go client for the CODA clinical terminology API. Go 1.21+, standard library only.

Part of [CODA](https://github.com/ubeffiong/coda), clinical terminology intelligence: search, validation, value sets, mappings and an AI coding assistant across ICD-11, SNOMED CT, LOINC, RxNorm and more.

## Install

```bash
go get github.com/ubeffiong/coda/sdks/go@latest
```

## Quick start

```go
import coda "github.com/ubeffiong/coda/sdks/go"

client, err := coda.New(coda.Options{
    BaseURL: "https://coda.example.org",
    Token:   coda.StaticToken(os.Getenv("CODA_TOKEN")), // or your own func(ctx) (string, error)
})
if err != nil { log.Fatal(err) }

results, err := client.Search(ctx, "type 2 diabetes with nephropathy", []coda.SystemRef{{System: "http://id.who.int/icd/release/11/mms"}}, 5)
check, err := client.Validate(ctx, coda.CodingItem{System: "http://loinc.org", Code: "2345-7", Display: "Glucose"})
```

## Verify a webhook

```go
func codaWebhook(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    if !coda.VerifyWebhook(secret, r.Header, body, time.Now(), 5*time.Minute) {
        http.Error(w, "bad signature", http.StatusUnauthorized)
        return
    }
    w.WriteHeader(http.StatusNoContent)
}
```

Releases are tagged `sdks/go/vX.Y.Z` so the Go module proxy can serve this sub-directory module.

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
