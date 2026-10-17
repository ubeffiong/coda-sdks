# Coda.Client

.NET client for the CODA clinical terminology API. .NET 8+, no dependencies beyond the BCL.

Part of [CODA](https://github.com/ubeffiong/coda-sdks), clinical terminology intelligence: search, validation, value sets, mappings and an AI coding assistant across ICD-11, SNOMED CT, LOINC, RxNorm and more.

## Install

```bash
dotnet add package Coda.Client
```

## Quick start

```csharp
using Coda.Client;

using var coda = new CodaClient(new CodaClientOptions
{
    BaseUrl = new Uri("https://coda.example.org"),
    TokenProvider = async ct => await tokens.GetAccessTokenAsync(ct), // or CodaClientOptions.StaticToken("...")
});

var results = await coda.SearchAsync("type 2 diabetes with nephropathy", [new SystemRef("http://id.who.int/icd/release/11/mms")], count: 5);
var check = await coda.ValidateAsync("http://loinc.org", "2345-7", display: "Glucose");
```

Pass your own `HttpClient` (for example from `IHttpClientFactory`) as the second constructor argument.

## Verify a webhook

```csharp
app.MapPost("/coda/webhooks", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var body = await reader.ReadToEndAsync();
    var headers = request.Headers.Select(h => KeyValuePair.Create(h.Key, h.Value.ToString()));
    if (!CodaWebhooks.Verify(secret, headers, body)) return Results.Unauthorized();
    return Results.NoContent();
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
- Integration guide: [docs/EMR-INTEGRATION.md](https://github.com/ubeffiong/coda-sdks/blob/main/docs/EMR-INTEGRATION.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Licence: [Apache-2.0](LICENSE)
