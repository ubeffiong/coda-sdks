package coda

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type recorded struct {
	Method, URI, Body string
	Header          http.Header
}

type reply struct {
	Status  int
	JSON    string
	Headers map[string]string
}

func mock(t *testing.T, replies ...reply) (*Client, *[]recorded) {
	t.Helper()
	var mu sync.Mutex
	var reqs []recorded
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		reqs = append(reqs, recorded{r.Method, r.URL.RequestURI(), string(body), r.Header.Clone()})
		rep := replies[0]
		replies = replies[1:]
		mu.Unlock()
		for k, v := range rep.Headers {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rep.Status)
		_, _ = w.Write([]byte(rep.JSON))
	}))
	t.Cleanup(srv.Close)
	c, err := New(Options{BaseURL: srv.URL + "/", Token: StaticToken("tok-1")})
	if err != nil {
		t.Fatal(err)
	}
	return c, &reqs
}

func TestSearchPostsQueryWithAuthAndRequestID(t *testing.T) {
	c, reqs := mock(t, reply{200, `{"requestId":"r1","groups":[]}`, nil})
	r, err := c.Search(context.Background(), "type 2 diabetes", []SystemRef{{System: "urn:coda:fixture:clinical"}}, 5)
	if err != nil || r["requestId"] != "r1" {
		t.Fatalf("unexpected: %v %v", r, err)
	}
	req := (*reqs)[0]
	if req.Method != "POST" || req.URI != "/api/v1/search" || req.Header.Get("Authorization") != "Bearer tok-1" || req.Header.Get("X-Request-Id") == "" {
		t.Fatalf("bad request: %+v", req)
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(req.Body), &body)
	if body["query"] != "type 2 diabetes" || body["count"] != float64(5) {
		t.Fatalf("bad body: %s", req.Body)
	}
}

func TestLookupEncodesQuery(t *testing.T) {
	c, reqs := mock(t, reply{200, `{"code":"1A00"}`, nil})
	if _, err := c.Lookup(context.Background(), "http://id.who.int/icd/release/11/mms", "1A00", "2025-01"); err != nil {
		t.Fatal(err)
	}
	want := "/api/v1/concepts/lookup?code=1A00&system=http%3A%2F%2Fid.who.int%2Ficd%2Frelease%2F11%2Fmms&version=2025-01"
	if (*reqs)[0].URI != want {
		t.Fatalf("got %s", (*reqs)[0].URI)
	}
}

func TestProblemsBecomeAPIErrorsWithoutRetry(t *testing.T) {
	c, reqs := mock(t, reply{422, `{"code":"UNKNOWN_CODE_SYSTEM","detail":"not registered","correlationId":"c-1","retryable":false}`, nil})
	_, err := c.Validate(context.Background(), CodingItem{System: "urn:nope", Code: "X"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 422 || apiErr.Code != "UNKNOWN_CODE_SYSTEM" || apiErr.CorrelationID != "c-1" || apiErr.Retryable {
		t.Fatalf("unexpected: %v", err)
	}
	if len(*reqs) != 1 {
		t.Fatalf("retried a client error")
	}
}

func TestRateLimitRetriedWithSameRequestID(t *testing.T) {
	c, reqs := mock(t, reply{429, `{"code":"RATE_LIMITED","retryable":true}`, map[string]string{"Retry-After": "0"}}, reply{200, `{"outcome":"valid"}`, nil})
	r, err := c.Validate(context.Background(), CodingItem{System: "urn:coda:fixture:clinical", Code: "FX-111200"})
	if err != nil || r["outcome"] != "valid" || len(*reqs) != 2 {
		t.Fatalf("unexpected: %v %v %d", r, err, len(*reqs))
	}
	if (*reqs)[0].Header.Get("X-Request-Id") != (*reqs)[1].Header.Get("X-Request-Id") {
		t.Fatal("request id changed between retries")
	}
}

func TestGivesUpAfterMaxRetries(t *testing.T) {
	down := reply{503, `{"code":"TERMINOLOGY_PROVIDER_UNAVAILABLE","retryable":true}`, map[string]string{"Retry-After": "0"}}
	c, reqs := mock(t, down, down, down)
	_, err := c.Systems(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "TERMINOLOGY_PROVIDER_UNAVAILABLE" || len(*reqs) != 3 {
		t.Fatalf("unexpected: %v after %d requests", err, len(*reqs))
	}
}

func TestFHIRAndDecisionHeaders(t *testing.T) {
	c, reqs := mock(t, reply{200, `{"summary":{"total":0}}`, nil}, reply{201, `{"id":"d1"}`, nil})
	if _, err := c.ValidateFHIR(context.Background(), []byte(`{"resourceType":"Bundle","type":"collection","entry":[]}`), "idsr-immediate"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.RecordDecision(context.Background(), map[string]any{"purpose": "diagnosis", "outcome": "approved"}, "idem-42"); err != nil {
		t.Fatal(err)
	}
	if (*reqs)[0].Header.Get("Content-Type") != "application/fhir+json" || (*reqs)[0].URI != "/api/v1/codes/validate-fhir?valueSet=idsr-immediate" {
		t.Fatalf("bad fhir request: %+v", (*reqs)[0])
	}
	if (*reqs)[1].Header.Get("Idempotency-Key") != "idem-42" {
		t.Fatal("missing idempotency key")
	}
}

func TestOpensAConnectSessionAndLaunchesTheClinician(t *testing.T) {
	c, reqs := mock(t,
		reply{201, `{"id":"s-1","launchUrl":"https://coda.test/connect?session=s-1&launch=coda_lc_x"}`, nil},
		reply{200, `{"id":"s-1","status":"completed","result":{"selections":[{"code":"5A11"}]}}`, nil})
	s, err := c.OpenConnectSession(context.Background(), ConnectSessionRequest{
		AppID: "app-1", Text: "type 2 diabetes", PatientRef: "pt_3f2b8c1e", Clinician: &Clinician{Ref: "usr_7c1d2e9a", Name: "Dr A. Bello"},
	})
	if err != nil || s["id"] != "s-1" {
		t.Fatalf("unexpected: %v %v", s, err)
	}
	done, err := c.GetConnectSession(context.Background(), "s-1")
	if err != nil || done["status"] != "completed" {
		t.Fatalf("unexpected: %v %v", done, err)
	}
	open := (*reqs)[0]
	if open.Method != "POST" || open.URI != "/api/v1/connect/sessions" {
		t.Fatalf("bad request: %+v", open)
	}
	if open.Body != `{"appId":"app-1","text":"type 2 diabetes","patientRef":"pt_3f2b8c1e","clinician":{"ref":"usr_7c1d2e9a","name":"Dr A. Bello"}}` {
		t.Fatalf("bad body: %s", open.Body)
	}
	if (*reqs)[1].URI != "/api/v1/connect/sessions/s-1" {
		t.Fatalf("bad get: %+v", (*reqs)[1])
	}
}
