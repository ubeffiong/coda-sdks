package org.coda.client;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.TreeMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Verification of CODA webhooks (Standard Webhooks signatures). */
public final class CodaWebhooks {
    private CodaWebhooks() {
    }

    /**
     * True when the delivery was signed by CODA with {@code secret} ("whsec_...") and is within
     * {@code tolerance} of {@code now}. Pass the raw body exactly as received; header names are case-insensitive.
     */
    public static boolean verify(String secret, Map<String, String> headers, String body, Instant now, Duration tolerance) {
        Map<String, String> h = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        h.putAll(headers);
        String id = h.get("webhook-id");
        String timestamp = h.get("webhook-timestamp");
        String signature = h.get("webhook-signature");
        if (id == null || timestamp == null || signature == null) {
            return false;
        }
        long ts;
        try {
            ts = Long.parseLong(timestamp);
        } catch (NumberFormatException e) {
            return false;
        }
        if (Math.abs(now.getEpochSecond() - ts) > tolerance.getSeconds()) {
            return false;
        }

        byte[] key = Base64.getDecoder().decode(secret.startsWith("whsec_") ? secret.substring(6) : secret);
        byte[] expected;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] digest = mac.doFinal((id + "." + timestamp + "." + body).getBytes(StandardCharsets.UTF_8));
            expected = ("v1," + Base64.getEncoder().encodeToString(digest)).getBytes(StandardCharsets.US_ASCII);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is unavailable.", e);
        }
        for (String candidate : signature.split(" ")) {
            if (MessageDigest.isEqual(candidate.getBytes(StandardCharsets.US_ASCII), expected)) {
                return true;
            }
        }
        return false;
    }

    /** Verifies with the current time and a 5-minute tolerance. */
    public static boolean verify(String secret, Map<String, String> headers, String body) {
        return verify(secret, headers, body, Instant.now(), Duration.ofMinutes(5));
    }
}
