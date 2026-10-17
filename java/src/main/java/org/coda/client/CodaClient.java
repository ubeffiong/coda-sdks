package org.coda.client;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * Client for the CODA clinical terminology API (v1). Responses are Jackson {@link JsonNode}s with the
 * API's own field names. Thread-safe; reuse one instance. See ../README.md for the shared contract.
 */
public final class CodaClient {
    private static final ObjectMapper JSON = new ObjectMapper().setSerializationInclusion(JsonInclude.Include.NON_NULL);

    private final String baseUrl;
    private final Supplier<String> tokenProvider;
    private final Duration timeout;
    private final int maxRetries;
    private final HttpClient http;

    private CodaClient(Builder b) {
        this.baseUrl = b.baseUrl.replaceAll("/+$", "");
        this.tokenProvider = b.tokenProvider;
        this.timeout = b.timeout;
        this.maxRetries = b.maxRetries;
        this.http = b.httpClient != null ? b.httpClient : HttpClient.newBuilder().connectTimeout(b.timeout).build();
    }

    public static Builder builder() {
        return new Builder();
    }

    /** A code system reference, optionally pinned to a release. */
    public record SystemRef(String system, String version) {
        public static SystemRef of(String system) {
            return new SystemRef(system, null);
        }
    }

    /** One coding to validate in a batch. */
    public record CodingItem(String system, String code, String version, String display, String valueSetUrl) {
        public static CodingItem of(String system, String code) {
            return new CodingItem(system, code, null, null, null);
        }
    }

    /** Your signed-in user, vouched for by your integration: an opaque id and an optional display name. */
    public record Clinician(String ref, String name) {
    }

    /**
     * Opens a CODA Connect session. Send only the clinical phrase as {@code text}; patientRef and
     * encounterRef are opaque tokens your EMR generates and maps (random, never an MRN or a hash of
     * one). With a clinician (calling with an integration key), launchUrl signs that user into this
     * one session without a CODA login. Build with {@link #of} and the {@code with…} methods.
     */
    public record ConnectSessionRequest(
            String appId, String text, List<String> systems, String valueSet, String purpose, Integer maxSelections,
            String returnOrigin, Boolean webhook, Integer expiresInMinutes, String patientRef, String encounterRef, Clinician clinician) {

        public static ConnectSessionRequest of(String appId, String text) {
            return new ConnectSessionRequest(appId, text, null, null, null, null, null, null, null, null, null, null);
        }

        public ConnectSessionRequest withSystems(List<String> value) {
            return new ConnectSessionRequest(appId, text, value, valueSet, purpose, maxSelections, returnOrigin, webhook, expiresInMinutes, patientRef, encounterRef, clinician);
        }

        public ConnectSessionRequest withMaxSelections(int value) {
            return new ConnectSessionRequest(appId, text, systems, valueSet, purpose, value, returnOrigin, webhook, expiresInMinutes, patientRef, encounterRef, clinician);
        }

        public ConnectSessionRequest withReturnOrigin(String value) {
            return new ConnectSessionRequest(appId, text, systems, valueSet, purpose, maxSelections, value, webhook, expiresInMinutes, patientRef, encounterRef, clinician);
        }

        public ConnectSessionRequest withPatientRef(String value) {
            return new ConnectSessionRequest(appId, text, systems, valueSet, purpose, maxSelections, returnOrigin, webhook, expiresInMinutes, value, encounterRef, clinician);
        }

        public ConnectSessionRequest withEncounterRef(String value) {
            return new ConnectSessionRequest(appId, text, systems, valueSet, purpose, maxSelections, returnOrigin, webhook, expiresInMinutes, patientRef, value, clinician);
        }

        public ConnectSessionRequest withClinician(String ref, String name) {
            return new ConnectSessionRequest(appId, text, systems, valueSet, purpose, maxSelections, returnOrigin, webhook, expiresInMinutes, patientRef, encounterRef, new Clinician(ref, name));
        }
    }

    public JsonNode systems() {
        return send("GET", "/api/v1/systems", null, null);
    }

    public JsonNode lookup(String system, String code, String version) {
        return send("GET", "/api/v1/concepts/lookup?" + query("system", system, "code", code, "version", version), null, null);
    }

    public JsonNode search(String query, List<SystemRef> systems, Integer count, Boolean includeInactive) {
        return send("POST", "/api/v1/search", body("query", query, "systems", systems, "count", count, "includeInactive", includeInactive), null);
    }

    public JsonNode validate(String system, String code, String version, String display, String valueSetUrl) {
        return send("POST", "/api/v1/codes/validate", body("system", system, "code", code, "version", version, "display", display, "valueSetUrl", valueSetUrl), null);
    }

    public JsonNode validateBatch(List<CodingItem> items) {
        return send("POST", "/api/v1/codes/validate-batch", body("items", items), null);
    }

    /** Validates every Coding in a FHIR R4 resource or Bundle (JSON text). */
    public JsonNode validateFhir(String resourceJson, String valueSet) {
        String path = "/api/v1/codes/validate-fhir" + (valueSet == null ? "" : "?" + query("valueSet", valueSet));
        return send("POST", path, new Raw(resourceJson, "application/fhir+json"), null);
    }

    public JsonNode expand(String valueSet, String filter, Integer offset, Integer count) {
        return send("POST", "/api/v1/expand", body("valueSet", valueSet, "filter", filter, "offset", offset, "count", count), null);
    }

    public JsonNode translate(String system, String code) {
        return send("POST", "/api/v1/translate", body("system", system, "code", code), null);
    }

    /** Grounded suggestions for a clinical phrase. Every candidate needs human review. */
    public JsonNode analyzePhrase(String phrase, List<SystemRef> systems) {
        return send("POST", "/api/v1/phrases/analyze", body("phrase", phrase, "systems", systems), null).get("result");
    }

    /** Opens a CODA Connect session; returns its id and launchUrl. Call from your server with an integration key. */
    public JsonNode openConnectSession(ConnectSessionRequest request) {
        Objects.requireNonNull(request, "request");
        if (request.appId() == null || request.appId().isBlank()) {
            throw new IllegalArgumentException("appId is required");
        }
        return send("POST", "/api/v1/connect/sessions", request, null);
    }

    /** A session and, once the clinician has finished, its result (also delivered by webhook). */
    public JsonNode getConnectSession(String sessionId) {
        return send("GET", "/api/v1/connect/sessions/" + URLEncoder.encode(sessionId, StandardCharsets.UTF_8), null, null);
    }

    /** Records a human-reviewed decision; reuse the idempotency key when retrying the same decision. */
    public JsonNode recordDecision(Map<String, Object> request, String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new IllegalArgumentException("idempotencyKey is required");
        }
        return send("POST", "/api/v1/decisions", request, idempotencyKey);
    }

    private JsonNode send(String method, String path, Object body, String idempotencyKey) {
        String requestId = UUID.randomUUID().toString().replace("-", "");
        for (int attempt = 0; ; attempt++) {
            HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(baseUrl + path))
                    .timeout(timeout)
                    .header("Authorization", "Bearer " + tokenProvider.get())
                    .header("Accept", "application/json")
                    .header("X-Request-Id", requestId);
            if (idempotencyKey != null) {
                rb.header("Idempotency-Key", idempotencyKey);
            }
            if (body == null) {
                rb.method(method, HttpRequest.BodyPublishers.noBody());
            } else if (body instanceof Raw raw) {
                rb.header("Content-Type", raw.mediaType()).method(method, HttpRequest.BodyPublishers.ofString(raw.text()));
            } else {
                rb.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(write(body)));
            }

            HttpResponse<String> response;
            try {
                response = http.send(rb.build(), HttpResponse.BodyHandlers.ofString());
            } catch (IOException e) {
                if (attempt < maxRetries) {
                    sleep(backoff(attempt, null));
                    continue;
                }
                throw new CodaApiException(0, "NETWORK_ERROR", "The CODA API could not be reached: " + e.getMessage(), requestId, true);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new CodaApiException(0, "INTERRUPTED", "The request was interrupted.", requestId, false);
            }

            int status = response.statusCode();
            if (status >= 200 && status < 300) {
                return read(response.body());
            }

            CodaApiException error = problem(status, response.body(), requestId);
            if (attempt < maxRetries && (status == 429 || status == 503)) {
                sleep(backoff(attempt, response.headers().firstValue("Retry-After").orElse(null)));
                continue;
            }
            throw error;
        }
    }

    private static CodaApiException problem(int status, String text, String requestId) {
        JsonNode p;
        try {
            p = JSON.readTree(text == null || text.isEmpty() ? "{}" : text);
        } catch (IOException e) {
            p = JSON.createObjectNode();
        }
        String code = p.path("code").asText("HTTP_" + status);
        String detail = p.hasNonNull("detail") ? p.get("detail").asText() : p.path("title").asText("Request failed.");
        String correlationId = p.hasNonNull("correlationId") ? p.get("correlationId").asText() : requestId;
        return new CodaApiException(status, code, detail, correlationId, p.path("retryable").asBoolean(false));
    }

    static long backoff(int attempt, String retryAfter) {
        long ms = (long) (250 * Math.pow(2, attempt));
        if (retryAfter != null) {
            try {
                ms = (long) (Double.parseDouble(retryAfter) * 1000);
            } catch (NumberFormatException e) {
                try {
                    ms = Duration.between(ZonedDateTime.now(), ZonedDateTime.parse(retryAfter, DateTimeFormatter.RFC_1123_DATE_TIME)).toMillis();
                } catch (RuntimeException ignored) {
                    // Keep the exponential default.
                }
            }
        }
        return Math.min(Math.max(ms, 0), 10_000);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static ObjectNode body(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            if (pairs[i + 1] != null) {
                map.put((String) pairs[i], pairs[i + 1]);
            }
        }
        return JSON.valueToTree(map);
    }

    private static String query(String... pairs) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < pairs.length; i += 2) {
            if (pairs[i + 1] == null) {
                continue;
            }
            if (!sb.isEmpty()) {
                sb.append('&');
            }
            sb.append(pairs[i]).append('=').append(URLEncoder.encode(pairs[i + 1], StandardCharsets.UTF_8).replace("+", "%20"));
        }
        return sb.toString();
    }

    private static String write(Object body) {
        try {
            return JSON.writeValueAsString(body);
        } catch (IOException e) {
            throw new IllegalArgumentException("Request body could not be serialized.", e);
        }
    }

    private static JsonNode read(String text) {
        try {
            return JSON.readTree(text);
        } catch (IOException e) {
            throw new CodaApiException(200, "MALFORMED_RESPONSE", "The response was not valid JSON.", null, false);
        }
    }

    private record Raw(String text, String mediaType) {
    }

    /** Builder for {@link CodaClient}. */
    public static final class Builder {
        private String baseUrl;
        private Supplier<String> tokenProvider;
        private Duration timeout = Duration.ofSeconds(30);
        private int maxRetries = 2;
        private HttpClient httpClient;

        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        /** A fixed bearer token. */
        public Builder token(String token) {
            this.tokenProvider = () -> token;
            return this;
        }

        /** Called before every request (refresh tokens here). */
        public Builder tokenProvider(Supplier<String> provider) {
            this.tokenProvider = provider;
            return this;
        }

        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        public Builder maxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
            return this;
        }

        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        public CodaClient build() {
            Objects.requireNonNull(baseUrl, "baseUrl");
            Objects.requireNonNull(tokenProvider, "token or tokenProvider");
            return new CodaClient(this);
        }
    }

    /** Debug helper: header names CODA sends (no values). */
    static String describe(Map<String, List<String>> headers) {
        return headers.keySet().stream().sorted().collect(Collectors.joining(","));
    }
}
