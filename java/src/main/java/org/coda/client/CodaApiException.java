package org.coda.client;

/** An RFC 7807 problem returned by CODA, with its stable error code. */
public final class CodaApiException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final int status;
    private final String code;
    private final String detail;
    private final String correlationId;
    private final boolean retryable;

    public CodaApiException(int status, String code, String detail, String correlationId, boolean retryable) {
        super(code + " (" + status + "): " + detail);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.correlationId = correlationId;
        this.retryable = retryable;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public String detail() {
        return detail;
    }

    public String correlationId() {
        return correlationId;
    }

    public boolean retryable() {
        return retryable;
    }
}
