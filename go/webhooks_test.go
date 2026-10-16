package coda

import (
	"net/http"
	"testing"
	"time"
)

func TestVerifyWebhookSharedVector(t *testing.T) {
	secret := "whsec_Y29kYS10ZXN0LXdlYmhvb2stc2VjcmV0LTMyYnl0ZXM="
	h := http.Header{}
	h.Set("Webhook-Id", "0198f1a2-0000-7000-8000-000000000001")
	h.Set("Webhook-Timestamp", "1792100000")
	h.Set("Webhook-Signature", "v0,old v1,iBHZWsokVTH0FJlTSGXVgcKqbLZN1NklHSqCNCG733Q=")
	body := []byte(`{"id":"0198f1a2-0000-7000-8000-000000000001","type":"webhook.ping","data":{"message":"CODA webhook test"}}`)
	at := time.Unix(1792100000, 0)

	if !VerifyWebhook(secret, h, body, at, 5*time.Minute) {
		t.Fatal("valid signature rejected")
	}
	if VerifyWebhook(secret, h, append(body, ' '), at, 5*time.Minute) {
		t.Fatal("tampered body accepted")
	}
	if VerifyWebhook(secret, h, body, at.Add(10*time.Minute), 5*time.Minute) {
		t.Fatal("replay accepted")
	}
	if VerifyWebhook("whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", h, body, at, 5*time.Minute) {
		t.Fatal("wrong secret accepted")
	}
}
