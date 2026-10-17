// Package coda is a client for the CODA clinical terminology API (v1). Standard library only.
// See ../README.md for the contract shared by all CODA SDKs.
package coda

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Object is a JSON response with the API's own field names.
type Object = map[string]any

// SystemRef names a code system, optionally pinned to a release.
type SystemRef struct {
	System  string `json:"system"`
	Version string `json:"version,omitempty"`
}

// CodingItem is one coding to validate in a batch.
type CodingItem struct {
	System      string `json:"system"`
	Code        string `json:"code"`
	Version     string `json:"version,omitempty"`
	Display     string `json:"display,omitempty"`
	ValueSetURL string `json:"valueSetUrl,omitempty"`
}

// APIError is an RFC 7807 problem returned by CODA, with its stable error code.
type APIError struct {
	Status        int
	Code          string
	Detail        string
	CorrelationID string
	Retryable     bool
}

func (e *APIError) Error() string { return fmt.Sprintf("%s (%d): %s", e.Code, e.Status, e.Detail) }

// Options configures a Client.
type Options struct {
	BaseURL string
	// Token returns the bearer token for each request (refresh it here).
	Token      func(ctx context.Context) (string, error)
	Timeout    time.Duration // default 30s
	MaxRetries int           // default 2; set -1 for none
	HTTPClient *http.Client
}

// StaticToken returns a Token func for a fixed token.
func StaticToken(token string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) { return token, nil }
}

// Client is safe for concurrent use.
type Client struct {
	base       string
	token      func(context.Context) (string, error)
	maxRetries int
	http       *http.Client
}

// New creates a Client.
func New(o Options) (*Client, error) {
	if o.BaseURL == "" || o.Token == nil {
		return nil, errors.New("coda: BaseURL and Token are required")
	}
	timeout := o.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	retries := o.MaxRetries
	if retries == 0 {
		retries = 2
	} else if retries < 0 {
		retries = 0
	}
	hc := o.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: timeout}
	}
	return &Client{base: strings.TrimRight(o.BaseURL, "/"), token: o.Token, maxRetries: retries, http: hc}, nil
}

// Systems lists registered code systems, releases and capabilities.
func (c *Client) Systems(ctx context.Context) ([]Object, error) {
	var out []Object
	return out, c.send(ctx, http.MethodGet, "/api/v1/systems", nil, "", &out)
}

// Lookup returns one concept in a resolved release.
func (c *Client) Lookup(ctx context.Context, system, code, version string) (Object, error) {
	q := url.Values{"system": {system}, "code": {code}}
	if version != "" {
		q.Set("version", version)
	}
	return c.object(ctx, http.MethodGet, "/api/v1/concepts/lookup?"+encode(q), nil, "")
}

// Search searches one or more systems; POST keeps clinical text out of URLs.
func (c *Client) Search(ctx context.Context, query string, systems []SystemRef, count int) (Object, error) {
	body := map[string]any{"query": query, "systems": systems}
	if count > 0 {
		body["count"] = count
	}
	return c.object(ctx, http.MethodPost, "/api/v1/search", body, "")
}

// Validate checks a code: valid, inactive, invalid, unknown or unsupported.
func (c *Client) Validate(ctx context.Context, item CodingItem) (Object, error) {
	return c.object(ctx, http.MethodPost, "/api/v1/codes/validate", item, "")
}

// ValidateBatch validates up to 500 codings with a quality summary.
func (c *Client) ValidateBatch(ctx context.Context, items []CodingItem) (Object, error) {
	return c.object(ctx, http.MethodPost, "/api/v1/codes/validate-batch", map[string]any{"items": items}, "")
}

// ValidateFHIR validates every Coding in a FHIR R4 resource or Bundle (JSON bytes).
func (c *Client) ValidateFHIR(ctx context.Context, resource []byte, valueSet string) (Object, error) {
	path := "/api/v1/codes/validate-fhir"
	if valueSet != "" {
		path += "?" + encode(url.Values{"valueSet": {valueSet}})
	}
	return c.object(ctx, http.MethodPost, path, raw{resource, "application/fhir+json"}, "")
}

// Expand expands a value set by key or canonical URL.
func (c *Client) Expand(ctx context.Context, valueSet, filter string, offset, count int) (Object, error) {
	body := map[string]any{"valueSet": valueSet, "offset": offset}
	if filter != "" {
		body["filter"] = filter
	}
	if count > 0 {
		body["count"] = count
	}
	return c.object(ctx, http.MethodPost, "/api/v1/expand", body, "")
}

// Translate translates a local code through approved mappings only.
func (c *Client) Translate(ctx context.Context, system, code string) (Object, error) {
	return c.object(ctx, http.MethodPost, "/api/v1/translate", map[string]any{"system": system, "code": code}, "")
}

// AnalyzePhrase returns grounded suggestions; every candidate needs human review.
func (c *Client) AnalyzePhrase(ctx context.Context, phrase string, systems []SystemRef) (Object, error) {
	r, err := c.object(ctx, http.MethodPost, "/api/v1/phrases/analyze", map[string]any{"phrase": phrase, "systems": systems}, "")
	if err != nil {
		return nil, err
	}
	result, _ := r["result"].(Object)
	return result, nil
}

// Clinician is your signed-in user, vouched for by your integration: an opaque id and an optional display name.
type Clinician struct {
	Ref  string `json:"ref"`
	Name string `json:"name,omitempty"`
}

// ConnectSessionRequest opens a CODA Connect session. Send only the clinical phrase as Text.
// PatientRef and EncounterRef are opaque tokens your EMR generates and maps (random, never an MRN
// or a hash of one). With Clinician (calling with an integration key), LaunchURL signs that user
// into this one session without a CODA login.
type ConnectSessionRequest struct {
	AppID            string     `json:"appId"`
	Text             string     `json:"text,omitempty"`
	Systems          []string   `json:"systems,omitempty"`
	ValueSet         string     `json:"valueSet,omitempty"`
	Purpose          string     `json:"purpose,omitempty"`
	MaxSelections    int        `json:"maxSelections,omitempty"`
	ReturnOrigin     string     `json:"returnOrigin,omitempty"`
	Webhook          *bool      `json:"webhook,omitempty"`
	ExpiresInMinutes int        `json:"expiresInMinutes,omitempty"`
	PatientRef       string     `json:"patientRef,omitempty"`
	EncounterRef     string     `json:"encounterRef,omitempty"`
	Clinician        *Clinician `json:"clinician,omitempty"`
}

// OpenConnectSession opens a CODA Connect session and returns its id and launchUrl. Call it from
// your server with an integration key as the token.
func (c *Client) OpenConnectSession(ctx context.Context, request ConnectSessionRequest) (Object, error) {
	if request.AppID == "" {
		return nil, errors.New("coda: AppID is required")
	}
	return c.object(ctx, http.MethodPost, "/api/v1/connect/sessions", request, "")
}

// GetConnectSession returns a session and, once the clinician has finished, its result (also delivered by webhook).
func (c *Client) GetConnectSession(ctx context.Context, sessionID string) (Object, error) {
	return c.object(ctx, http.MethodGet, "/api/v1/connect/sessions/"+url.PathEscape(sessionID), nil, "")
}

// RecordDecision records a human-reviewed decision; reuse the key when retrying the same decision.
func (c *Client) RecordDecision(ctx context.Context, request any, idempotencyKey string) (Object, error) {
	if idempotencyKey == "" {
		return nil, errors.New("coda: idempotencyKey is required")
	}
	return c.object(ctx, http.MethodPost, "/api/v1/decisions", request, idempotencyKey)
}

type raw struct {
	data      []byte
	mediaType string
}

func (c *Client) object(ctx context.Context, method, path string, body any, idem string) (Object, error) {
	var out Object
	return out, c.send(ctx, method, path, body, idem, &out)
}

func (c *Client) send(ctx context.Context, method, path string, body any, idem string, out any) error {
	requestID := newID()
	var payload []byte
	contentType := ""
	switch b := body.(type) {
	case nil:
	case raw:
		payload, contentType = b.data, b.mediaType
	default:
		var err error
		if payload, err = json.Marshal(b); err != nil {
			return fmt.Errorf("coda: encoding request: %w", err)
		}
		contentType = "application/json"
	}

	for attempt := 0; ; attempt++ {
		token, err := c.token(ctx)
		if err != nil {
			return fmt.Errorf("coda: token: %w", err)
		}
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("X-Request-Id", requestID)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		if idem != "" {
			req.Header.Set("Idempotency-Key", idem)
		}

		resp, err := c.http.Do(req)
		if err != nil {
			if ctx.Err() == nil && attempt < c.maxRetries {
				if werr := wait(ctx, backoff(attempt, "")); werr != nil {
					return werr
				}
				continue
			}
			return &APIError{Code: "NETWORK_ERROR", Detail: "The CODA API could not be reached: " + err.Error(), CorrelationID: requestID, Retryable: true}
		}
		data, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return json.Unmarshal(data, out)
		}
		apiErr := problem(resp.StatusCode, data, requestID)
		if attempt < c.maxRetries && (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable) {
			if werr := wait(ctx, backoff(attempt, resp.Header.Get("Retry-After"))); werr != nil {
				return werr
			}
			continue
		}
		return apiErr
	}
}

func problem(status int, data []byte, requestID string) *APIError {
	var p map[string]any
	_ = json.Unmarshal(data, &p)
	str := func(k string) string {
		if s, ok := p[k].(string); ok {
			return s
		}
		return ""
	}
	e := &APIError{Status: status, Code: str("code"), Detail: str("detail"), CorrelationID: str("correlationId")}
	if e.Code == "" {
		e.Code = "HTTP_" + strconv.Itoa(status)
	}
	if e.Detail == "" {
		e.Detail = str("title")
	}
	if e.CorrelationID == "" {
		e.CorrelationID = requestID
	}
	e.Retryable, _ = p["retryable"].(bool)
	return e
}

func backoff(attempt int, retryAfter string) time.Duration {
	d := time.Duration(250*math.Pow(2, float64(attempt))) * time.Millisecond
	if retryAfter != "" {
		if s, err := strconv.ParseFloat(retryAfter, 64); err == nil {
			d = time.Duration(s * float64(time.Second))
		} else if t, err := http.ParseTime(retryAfter); err == nil {
			d = time.Until(t)
		}
	}
	return max(0, min(d, 10*time.Second))
}

func wait(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// encode is url.Values.Encode with %20 instead of + (consistent with the other SDKs).
func encode(v url.Values) string { return strings.ReplaceAll(v.Encode(), "+", "%20") }

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
