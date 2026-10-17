package org.coda.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class CodaClientTest {
    record Recorded(String method, String uri, Map<String, List<String>> headers, String body) {}

    record Reply(int status, String json, Map<String, String> headers) {}

    private HttpServer server;
    private final List<Recorded> requests = new ArrayList<>();
    private final Deque<Reply> script = new ArrayDeque<>();

    private String start(Reply... replies) throws IOException {
        script.addAll(List.of(replies));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            requests.add(new Recorded(exchange.getRequestMethod(), exchange.getRequestURI().toString(), exchange.getRequestHeaders(), body));
            Reply r = script.removeFirst();
            r.headers().forEach((k, v) -> exchange.getResponseHeaders().add(k, v));
            exchange.getResponseHeaders().add("Content-Type", r.status() < 400 ? "application/json" : "application/problem+json");
            byte[] bytes = r.json().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(r.status(), bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    private static Reply ok(String json) {
        return new Reply(200, json, Map.of());
    }

    @Test
    void searchPostsQueryWithAuthAndRequestId() throws Exception {
        String url = start(ok("{\"requestId\":\"r1\",\"groups\":[]}"));
        var client = CodaClient.builder().baseUrl(url + "/").tokenProvider(() -> "tok-1").build();
        var r = client.search("type 2 diabetes", List.of(CodaClient.SystemRef.of("urn:coda:fixture:clinical")), 5, null);
        assertEquals("r1", r.get("requestId").asText());
        var req = requests.get(0);
        assertEquals("POST", req.method());
        assertEquals("/api/v1/search", req.uri());
        assertEquals("Bearer tok-1", req.headers().get("Authorization").get(0));
        assertNotNull(req.headers().get("X-request-id"));
        var mapper = new ObjectMapper();
        assertEquals(mapper.readTree("{\"query\":\"type 2 diabetes\",\"systems\":[{\"system\":\"urn:coda:fixture:clinical\"}],\"count\":5}"),
                mapper.readTree(req.body()));
    }

    @Test
    void opensAConnectSessionAndLaunchesTheClinician() throws Exception {
        String url = start(new Reply(201, "{\"id\":\"s-1\",\"launchUrl\":\"https://coda.test/connect?session=s-1&launch=coda_lc_x\"}", Map.of()),
                ok("{\"id\":\"s-1\",\"status\":\"completed\",\"result\":{\"selections\":[{\"code\":\"5A11\"}]}}"));
        var client = CodaClient.builder().baseUrl(url).token("coda_sk_integration-key").build();
        var s = client.openConnectSession(CodaClient.ConnectSessionRequest.of("app-1", "type 2 diabetes")
                .withPatientRef("pt_3f2b8c1e").withClinician("usr_7c1d2e9a", "Dr A. Bello"));
        assertEquals("s-1", s.get("id").asText());
        assertEquals("5A11", client.getConnectSession("s-1").get("result").get("selections").get(0).get("code").asText());

        var open = requests.get(0);
        assertEquals("POST", open.method());
        assertEquals("/api/v1/connect/sessions", open.uri());
        assertEquals("Bearer coda_sk_integration-key", open.headers().get("Authorization").get(0));
        var mapper = new ObjectMapper();
        assertEquals(mapper.readTree("{\"appId\":\"app-1\",\"text\":\"type 2 diabetes\",\"patientRef\":\"pt_3f2b8c1e\",\"clinician\":{\"ref\":\"usr_7c1d2e9a\",\"name\":\"Dr A. Bello\"}}"),
                mapper.readTree(open.body()));
        assertEquals("/api/v1/connect/sessions/s-1", requests.get(1).uri());
    }

    @Test
    void lookupEncodesQuery() throws Exception {
        String url = start(ok("{\"code\":\"1A00\"}"));
        CodaClient.builder().baseUrl(url).token("t").build().lookup("http://id.who.int/icd/release/11/mms", "1A00", "2025-01");
        assertEquals("/api/v1/concepts/lookup?system=http%3A%2F%2Fid.who.int%2Ficd%2Frelease%2F11%2Fmms&code=1A00&version=2025-01",
                requests.get(0).uri());
    }

    @Test
    void problemsBecomeExceptionsWithoutRetry() throws Exception {
        String url = start(new Reply(422,
                "{\"code\":\"UNKNOWN_CODE_SYSTEM\",\"detail\":\"not registered\",\"correlationId\":\"c-1\",\"retryable\":false}", Map.of()));
        var client = CodaClient.builder().baseUrl(url).token("t").build();
        var ex = assertThrows(CodaApiException.class, () -> client.validate("urn:nope", "X", null, null, null));
        assertEquals(422, ex.status());
        assertEquals("UNKNOWN_CODE_SYSTEM", ex.code());
        assertEquals("c-1", ex.correlationId());
        assertEquals(1, requests.size());
    }

    @Test
    void rateLimitIsRetriedWithSameRequestId() throws Exception {
        String url = start(new Reply(429, "{\"code\":\"RATE_LIMITED\",\"retryable\":true}", Map.of("Retry-After", "0")),
                ok("{\"outcome\":\"valid\"}"));
        var r = CodaClient.builder().baseUrl(url).token("t").build().validate("urn:coda:fixture:clinical", "FX-111200", null, null, null);
        assertEquals("valid", r.get("outcome").asText());
        assertEquals(2, requests.size());
        assertEquals(requests.get(0).headers().get("X-request-id"), requests.get(1).headers().get("X-request-id"));
    }

    @Test
    void givesUpAfterMaxRetries() throws Exception {
        Reply down = new Reply(503, "{\"code\":\"TERMINOLOGY_PROVIDER_UNAVAILABLE\",\"retryable\":true}", Map.of("Retry-After", "0"));
        String url = start(down, down);
        var client = CodaClient.builder().baseUrl(url).token("t").maxRetries(1).build();
        var ex = assertThrows(CodaApiException.class, client::systems);
        assertEquals("TERMINOLOGY_PROVIDER_UNAVAILABLE", ex.code());
        assertEquals(2, requests.size());
    }

    @Test
    void fhirAndDecisionHeaders() throws Exception {
        String url = start(ok("{\"summary\":{\"total\":0}}"), new Reply(201, "{\"id\":\"d1\"}", Map.of()));
        var client = CodaClient.builder().baseUrl(url).token("t").build();
        client.validateFhir("{\"resourceType\":\"Bundle\",\"type\":\"collection\",\"entry\":[]}", "idsr-immediate");
        client.recordDecision(Map.of("purpose", "diagnosis", "outcome", "approved"), "idem-42");
        assertEquals("application/fhir+json", requests.get(0).headers().get("Content-type").get(0));
        assertEquals("/api/v1/codes/validate-fhir?valueSet=idsr-immediate", requests.get(0).uri());
        assertEquals("idem-42", requests.get(1).headers().get("Idempotency-key").get(0));
    }
}
