# CODA client SDKs

Thin, dependency-light clients for the CODA terminology API (v1) in six languages. They all implement the same contract, so behaviour is the same whichever language an integrator uses.

| Language | Folder | Package name | Runtime deps |
|---|---|---|---|
| C# / .NET 8+ | [`dotnet/`](dotnet) | `Coda.Client` | none (BCL `HttpClient`, `System.Text.Json`) |
| TypeScript / JavaScript (Node 18+, browsers) | [`typescript/`](typescript) | `@coda-terminology/client` | none (`fetch`) |
| Python 3.9+ | [`python/`](python) | `coda-client` | none (standard library `urllib`) |
| Java 17+ | [`java/`](java) | `io.github.ubeffiong:coda-client` (Maven Central) | Jackson Databind |
| Go 1.21+ | [`go/`](go) | `github.com/ubeffiong/coda-sdks/go` | none (standard library) |
| Rust 1.70+ | [`rust/`](rust) | `coda-client` | `ureq`, `serde`, `serde_json` |

## Install

Every release is on [GitHub Releases](https://github.com/ubeffiong/coda-sdks/releases), checked with SHA256SUMS. One command downloads, verifies and installs the SDK into the project in your current folder:

```bash
# macOS, Linux, WSL, Git Bash
curl -fsSL https://raw.githubusercontent.com/ubeffiong/coda-sdks/main/install.sh | sh -s -- typescript   # or python, dotnet, java, go, rust
```

```powershell
# Windows PowerShell 7+
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ubeffiong/coda-sdks/main/install.ps1))) dotnet
```

Add a version to pin one, e.g. `... | sh -s -- python 0.1.0`. To install directly without the script:

| Language | From GitHub |
|---|---|
| TypeScript / JavaScript | `npm install https://github.com/ubeffiong/coda-sdks/releases/download/v0.1.0/coda-terminology-client-0.1.0.tgz` |
| Python | `pip install "coda-client @ git+https://github.com/ubeffiong/coda-sdks@v0.1.0#subdirectory=python"` |
| C# / .NET | download `Coda.Client.0.1.0.nupkg` from the release, then `dotnet add package Coda.Client --source <folder>` |
| Java | download `coda-client-0.1.0.jar`, then `mvn install:install-file -Dfile=coda-client-0.1.0.jar -DgroupId=io.github.ubeffiong -DartifactId=coda-client -Dversion=0.1.0 -Dpackaging=jar` |
| Go | `go get github.com/ubeffiong/coda-sdks/go@v0.1.0` |
| Rust | `cargo add coda-client --git https://github.com/ubeffiong/coda-sdks --tag v0.1.0` |

Once published, the usual registry commands work too (`npm install @coda-terminology/client`, `pip install coda-client`, `dotnet add package Coda.Client`, Maven Central, `cargo add coda-client`).

Integrating an EMR or another clinical system? Start with [docs/EMR-INTEGRATION.md](docs/EMR-INTEGRATION.md): samples for plain JavaScript, React and each SDK, plus HIPAA guidance for patient context.

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

## Licence and releases

All SDKs are licensed under [Apache-2.0](LICENSE) and versioned together with [Semantic Versioning](https://semver.org/). Each folder has its own README and CHANGELOG, which ship inside the package.

| Registry | Package |
|---|---|
| npm | `@coda-terminology/client` |
| PyPI | `coda-client` |
| NuGet | `Coda.Client` |
| Maven Central | `io.github.ubeffiong:coda-client` |
| Go modules | `github.com/ubeffiong/coda-sdks/go` (tags `go/vX.Y.Z`) |
| crates.io | `coda-client` |

A `vX.Y.Z` tag builds every package into a GitHub Release ([release.yml](.github/workflows/release.yml)); [publish.yml](.github/workflows/publish.yml) then publishes to the registries. See [RELEASING.md](RELEASING.md).
