package coda

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// VerifyWebhook reports whether a delivery was signed by CODA with secret ("whsec_...") and is
// within tolerance of now (Standard Webhooks). Pass the raw body exactly as received.
func VerifyWebhook(secret string, header http.Header, body []byte, now time.Time, tolerance time.Duration) bool {
	id, timestamp, signature := header.Get("webhook-id"), header.Get("webhook-timestamp"), header.Get("webhook-signature")
	if id == "" || timestamp == "" || signature == "" {
		return false
	}
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || math.Abs(float64(now.Unix()-ts)) > tolerance.Seconds() {
		return false
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + timestamp + "."))
	mac.Write(body)
	expected := []byte("v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	for _, candidate := range strings.Fields(signature) {
		if hmac.Equal([]byte(candidate), expected) {
			return true
		}
	}
	return false
}
