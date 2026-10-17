using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Coda.Client;

/// <summary>Options for <see cref="CodaClient"/>.</summary>
public sealed class CodaClientOptions
{
    /// <summary>CODA base URL, e.g. https://coda.example.org.</summary>
    public required Uri BaseUrl { get; init; }

    /// <summary>Returns the bearer token for each request (refresh it here). Required.</summary>
    public required Func<CancellationToken, ValueTask<string>> TokenProvider { get; init; }

    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Retries after 429, 503 or a network failure (all operations are safe to retry).</summary>
    public int MaxRetries { get; init; } = 2;

    /// <summary>Convenience for a fixed token.</summary>
    public static Func<CancellationToken, ValueTask<string>> StaticToken(string token) => _ => ValueTask.FromResult(token);
}

/// <summary>An RFC 7807 problem returned by CODA, with its stable error code.</summary>
public sealed class CodaApiException : Exception
{
    public CodaApiException(int status, string code, string detail, string? correlationId, bool retryable)
        : base($"{code} ({status}): {detail}")
    {
        Status = status;
        Code = code;
        Detail = detail;
        CorrelationId = correlationId;
        Retryable = retryable;
    }

    public CodaApiException()
        : this(0, "UNKNOWN", "Unknown error.", null, false)
    {
    }

    public CodaApiException(string message)
        : this(0, "UNKNOWN", message, null, false)
    {
    }

    public CodaApiException(string message, Exception inner)
        : base(message, inner)
    {
        Code = "NETWORK_ERROR";
        Detail = message;
        Retryable = true;
    }

    public int Status { get; }

    public string Code { get; } = "UNKNOWN";

    public string Detail { get; } = string.Empty;

    public string? CorrelationId { get; }

    public bool Retryable { get; }
}

public sealed record SystemRef(string System, string? Version = null);

/// <summary>Your signed-in user, vouched for by your integration: an opaque id and an optional display name.</summary>
public sealed record ConnectClinician(string Ref, string? Name = null);

/// <summary>
/// Opens a CODA Connect session. Send only the clinical phrase as <see cref="Text"/>. PatientRef and
/// EncounterRef are opaque tokens your EMR generates and maps (random, never an MRN or a hash of one).
/// With <see cref="Clinician"/> (calling with an integration key), launchUrl signs that user into this
/// one session without a CODA login.
/// </summary>
public sealed record ConnectSessionRequest
{
    public required string AppId { get; init; }
    public string? Text { get; init; }
    public IReadOnlyList<string>? Systems { get; init; }
    public string? ValueSet { get; init; }
    public string? Purpose { get; init; }
    public int? MaxSelections { get; init; }
    public string? ReturnOrigin { get; init; }
    public bool? Webhook { get; init; }
    public int? ExpiresInMinutes { get; init; }
    public string? PatientRef { get; init; }
    public string? EncounterRef { get; init; }
    public ConnectClinician? Clinician { get; init; }
}

public sealed record CodingItem(string System, string Code, string? Version = null, string? Display = null, string? ValueSetUrl = null);

/// <summary>
/// Client for the CODA terminology API (v1). Responses are returned as <see cref="JsonNode"/> with
/// the API's own field names, so new fields never break the client. Thread-safe; reuse one instance.
/// </summary>
public sealed class CodaClient : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly CodaClientOptions _options;

    public CodaClient(CodaClientOptions options, HttpClient? httpClient = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        _options = options;
        _ownsHttp = httpClient is null;
        _http = httpClient ?? new HttpClient();
        _http.Timeout = options.Timeout;
    }

    public Task<JsonNode> SystemsAsync(CancellationToken ct = default) => SendAsync(HttpMethod.Get, "/api/v1/systems", null, null, ct);

    public Task<JsonNode> LookupAsync(string system, string code, string? version = null, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Get, "/api/v1/concepts/lookup?" + Query(("system", system), ("code", code), ("version", version)), null, null, ct);

    public Task<JsonNode> SearchAsync(string query, IEnumerable<SystemRef> systems, int? count = null, bool? includeInactive = null, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/v1/search", new { query, systems, count, includeInactive }, null, ct);

    public Task<JsonNode> ValidateAsync(string system, string code, string? version = null, string? display = null, string? valueSetUrl = null, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/v1/codes/validate", new { system, code, version, display, valueSetUrl }, null, ct);

    public Task<JsonNode> ValidateBatchAsync(IEnumerable<CodingItem> items, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/v1/codes/validate-batch", new { items }, null, ct);

    /// <summary>Validates every Coding in a FHIR R4 resource or Bundle (JSON text).</summary>
    public Task<JsonNode> ValidateFhirAsync(string resourceJson, string? valueSet = null, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/v1/codes/validate-fhir" + (valueSet is null ? string.Empty : "?" + Query(("valueSet", valueSet))),
            new RawJson(resourceJson, "application/fhir+json"), null, ct);

    public Task<JsonNode> ExpandAsync(string valueSet, string? filter = null, int? offset = null, int? count = null, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/v1/expand", new { valueSet, filter, offset, count }, null, ct);

    public Task<JsonNode> TranslateAsync(string system, string code, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/v1/translate", new { system, code }, null, ct);

    /// <summary>Grounded suggestions for a clinical phrase. Every candidate needs human review.</summary>
    public Task<JsonNode> AnalyzePhraseAsync(string phrase, IEnumerable<SystemRef> systems, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/v1/phrases/analyze", new { phrase, systems }, null, ct);

    /// <summary>Opens a CODA Connect session; returns its id and launchUrl. Call from your server with an integration key.</summary>
    public Task<JsonNode> OpenConnectSessionAsync(ConnectSessionRequest request, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.AppId);
        return SendAsync(HttpMethod.Post, "/api/v1/connect/sessions", request, null, ct);
    }

    /// <summary>A session and, once the clinician has finished, its result (also delivered by webhook).</summary>
    public Task<JsonNode> GetConnectSessionAsync(string sessionId, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        return SendAsync(HttpMethod.Get, "/api/v1/connect/sessions/" + Uri.EscapeDataString(sessionId), null, null, ct);
    }

    /// <summary>Records a human-reviewed decision. Reuse the same idempotency key when retrying the same decision.</summary>
    public Task<JsonNode> RecordDecisionAsync(object request, string idempotencyKey, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);
        return SendAsync(HttpMethod.Post, "/api/v1/decisions", request, idempotencyKey, ct);
    }

    public void Dispose()
    {
        if (_ownsHttp)
        {
            _http.Dispose();
        }
    }

    private async Task<JsonNode> SendAsync(HttpMethod method, string path, object? body, string? idempotencyKey, CancellationToken ct)
    {
        var requestId = Guid.NewGuid().ToString("N");
        for (var attempt = 0; ; attempt++)
        {
            using var request = new HttpRequestMessage(method, new Uri(_options.BaseUrl, path));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await _options.TokenProvider(ct).ConfigureAwait(false));
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            request.Headers.Add("X-Request-Id", requestId);
            if (idempotencyKey is not null)
            {
                request.Headers.Add("Idempotency-Key", idempotencyKey);
            }

            request.Content = body switch
            {
                null => null,
                RawJson raw => new StringContent(raw.Text, Encoding.UTF8, raw.MediaType),
                _ => JsonContent.Create(body, options: Json),
            };

            HttpResponseMessage response;
            try
            {
                response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            }
            catch (HttpRequestException ex) when (attempt < _options.MaxRetries)
            {
                _ = ex;
                await Task.Delay(Backoff(attempt, null), ct).ConfigureAwait(false);
                continue;
            }
            catch (HttpRequestException ex)
            {
                throw new CodaApiException("The CODA API could not be reached.", ex);
            }

            using (response)
            {
                if (response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<JsonNode>(ct).ConfigureAwait(false)
                        ?? throw new CodaApiException((int)response.StatusCode, "EMPTY_RESPONSE", "The response had no body.", requestId, false);
                }

                var error = await ProblemAsync(response, requestId, ct).ConfigureAwait(false);
                if (attempt < _options.MaxRetries && response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable)
                {
                    await Task.Delay(Backoff(attempt, response.Headers.RetryAfter), ct).ConfigureAwait(false);
                    continue;
                }

                throw error;
            }
        }
    }

    private static async Task<CodaApiException> ProblemAsync(HttpResponseMessage response, string requestId, CancellationToken ct)
    {
        JsonNode? p = null;
        try
        {
            p = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
        }
        catch (JsonException)
        {
            // Not a problem document; fall back to the status line.
        }

        string? Str(string name) => p?[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        var status = (int)response.StatusCode;
        return new CodaApiException(status, Str("code") ?? $"HTTP_{status}", Str("detail") ?? Str("title") ?? response.ReasonPhrase ?? "Request failed.",
            Str("correlationId") ?? requestId, p?["retryable"] is JsonValue r && r.TryGetValue<bool>(out var b) && b);
    }

    private static TimeSpan Backoff(int attempt, RetryConditionHeaderValue? retryAfter)
    {
        var wait = retryAfter?.Delta ?? (retryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : TimeSpan.FromMilliseconds(250 * Math.Pow(2, attempt)));
        return TimeSpan.FromMilliseconds(Math.Clamp(wait.TotalMilliseconds, 0, 10_000));
    }

    private static string Query(params (string Key, string? Value)[] pairs) =>
        string.Join("&", pairs.Where(p => p.Value is not null).Select(p => $"{p.Key}={Uri.EscapeDataString(p.Value!)}"));

    private sealed record RawJson(string Text, string MediaType);

    /// <summary>Formats a number for query strings (culture-invariant).</summary>
    internal static string Num(int value) => value.ToString(CultureInfo.InvariantCulture);
}
