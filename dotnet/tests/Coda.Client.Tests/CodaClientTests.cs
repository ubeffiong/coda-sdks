using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Coda.Client;

namespace Coda.Client.Tests;

/// <summary>Replays scripted responses and records each request.</summary>
internal sealed class ScriptedHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpResponseMessage>> _responses = new();

    public List<(HttpRequestMessage Request, string? Body)> Requests { get; } = [];

    public ScriptedHandler Then(HttpStatusCode status, string json, Action<HttpResponseMessage>? configure = null)
    {
        _responses.Enqueue(() =>
        {
            var r = new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, status < HttpStatusCode.BadRequest ? "application/json" : "application/problem+json") };
            configure?.Invoke(r);
            return r;
        });
        return this;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add((request, request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));
        return _responses.Dequeue()();
    }
}

public sealed class CodaClientTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static (CodaClient Client, ScriptedHandler Handler) Create(int maxRetries = 2)
    {
        var handler = new ScriptedHandler();
        var client = new CodaClient(new CodaClientOptions
        {
            BaseUrl = new Uri("https://coda.test"),
            TokenProvider = CodaClientOptions.StaticToken("tok-1"),
            MaxRetries = maxRetries,
        }, new HttpClient(handler));
        return (client, handler);
    }

    [Fact]
    public async Task Search_posts_the_query_with_auth_and_request_id()
    {
        var (client, handler) = Create();
        handler.Then(HttpStatusCode.OK, """{"requestId":"r1","groups":[]}""");
        var result = await client.SearchAsync("type 2 diabetes", [new SystemRef("urn:coda:fixture:clinical")], count: 5, ct: Ct);

        Assert.Equal("r1", result["requestId"]!.GetValue<string>());
        var (req, body) = handler.Requests.Single();
        Assert.Equal((HttpMethod.Post, "https://coda.test/api/v1/search"), (req.Method, req.RequestUri!.ToString()));
        Assert.Equal("Bearer tok-1", req.Headers.Authorization!.ToString());
        Assert.True(req.Headers.Contains("X-Request-Id"));
        var json = JsonNode.Parse(body!)!;
        Assert.Equal("type 2 diabetes", json["query"]!.GetValue<string>());
        Assert.Equal(5, json["count"]!.GetValue<int>());
        Assert.Null(json["includeInactive"]); // nulls are omitted
    }

    [Fact]
    public async Task Lookup_encodes_query_parameters()
    {
        var (client, handler) = Create();
        handler.Then(HttpStatusCode.OK, """{"code":"1A00"}""");
        await client.LookupAsync("http://id.who.int/icd/release/11/mms", "1A00", "2025-01", Ct);
        Assert.Equal("/api/v1/concepts/lookup?system=http%3A%2F%2Fid.who.int%2Ficd%2Frelease%2F11%2Fmms&code=1A00&version=2025-01",
            handler.Requests.Single().Request.RequestUri!.PathAndQuery);
    }

    [Fact]
    public async Task Problems_become_typed_exceptions_without_retry_for_client_errors()
    {
        var (client, handler) = Create();
        handler.Then(HttpStatusCode.UnprocessableEntity, """{"code":"UNKNOWN_CODE_SYSTEM","detail":"The requested code system is not registered.","correlationId":"c-1","retryable":false}""");
        var ex = await Assert.ThrowsAsync<CodaApiException>(() => client.ValidateAsync("urn:nope", "X", ct: Ct));
        Assert.Equal((422, "UNKNOWN_CODE_SYSTEM", "c-1", false), (ex.Status, ex.Code, ex.CorrelationId, ex.Retryable));
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Rate_limits_are_retried_after_retry_after_with_the_same_request_id()
    {
        var (client, handler) = Create();
        handler
            .Then(HttpStatusCode.TooManyRequests, """{"code":"RATE_LIMITED","detail":"slow down","retryable":true}""", r => r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.Zero))
            .Then(HttpStatusCode.OK, """{"outcome":"valid"}""");
        var result = await client.ValidateAsync("urn:coda:fixture:clinical", "FX-111200", ct: Ct);
        Assert.Equal("valid", result["outcome"]!.GetValue<string>());
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(handler.Requests[0].Request.Headers.GetValues("X-Request-Id").Single(), handler.Requests[1].Request.Headers.GetValues("X-Request-Id").Single());
    }

    [Fact]
    public async Task Gives_up_after_max_retries()
    {
        var (client, handler) = Create(maxRetries: 1);
        handler
            .Then(HttpStatusCode.ServiceUnavailable, """{"code":"TERMINOLOGY_PROVIDER_UNAVAILABLE","detail":"down","retryable":true}""", r => r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.Zero))
            .Then(HttpStatusCode.ServiceUnavailable, """{"code":"TERMINOLOGY_PROVIDER_UNAVAILABLE","detail":"down","retryable":true}""", r => r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.Zero));
        var ex = await Assert.ThrowsAsync<CodaApiException>(() => client.SystemsAsync(Ct));
        Assert.True(ex.Retryable);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task Fhir_resources_are_sent_verbatim_as_fhir_json()
    {
        var (client, handler) = Create();
        handler.Then(HttpStatusCode.OK, """{"summary":{"total":0}}""");
        const string bundle = """{"resourceType":"Bundle","type":"collection","entry":[]}""";
        await client.ValidateFhirAsync(bundle, "idsr-immediate", Ct);
        var (req, body) = handler.Requests.Single();
        Assert.Equal("application/fhir+json", req.Content!.Headers.ContentType!.MediaType);
        Assert.Equal(bundle, body);
        Assert.EndsWith("validate-fhir?valueSet=idsr-immediate", req.RequestUri!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Decisions_carry_the_idempotency_key()
    {
        var (client, handler) = Create();
        handler.Then(HttpStatusCode.Created, """{"id":"d1"}""");
        await client.RecordDecisionAsync(new { purpose = "diagnosis", outcome = "approved" }, "idem-42", Ct);
        Assert.Equal("idem-42", handler.Requests.Single().Request.Headers.GetValues("Idempotency-Key").Single());
    }
}
