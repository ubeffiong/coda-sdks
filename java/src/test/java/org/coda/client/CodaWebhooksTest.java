package org.coda.client;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CodaWebhooksTest {
    private static final String SECRET = "whsec_Y29kYS10ZXN0LXdlYmhvb2stc2VjcmV0LTMyYnl0ZXM=";
    private static final Map<String, String> HEADERS = Map.of(
            "Webhook-Id", "0198f1a2-0000-7000-8000-000000000001",
            "Webhook-Timestamp", "1792100000",
            "Webhook-Signature", "v0,old v1,iBHZWsokVTH0FJlTSGXVgcKqbLZN1NklHSqCNCG733Q=");
    private static final String BODY =
            "{\"id\":\"0198f1a2-0000-7000-8000-000000000001\",\"type\":\"webhook.ping\",\"data\":{\"message\":\"CODA webhook test\"}}";
    private static final Instant AT = Instant.ofEpochSecond(1792100000L);
    private static final Duration FIVE_MINUTES = Duration.ofMinutes(5);

    @Test
    void verifiesTheSharedVectorAndRejectsTamperingReplayAndWrongSecrets() {
        assertTrue(CodaWebhooks.verify(SECRET, HEADERS, BODY, AT, FIVE_MINUTES));
        assertFalse(CodaWebhooks.verify(SECRET, HEADERS, BODY + " ", AT, FIVE_MINUTES));
        assertFalse(CodaWebhooks.verify(SECRET, HEADERS, BODY, AT.plusSeconds(600), FIVE_MINUTES));
        assertFalse(CodaWebhooks.verify("whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", HEADERS, BODY, AT, FIVE_MINUTES));
    }
}
