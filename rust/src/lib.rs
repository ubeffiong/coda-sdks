//! Client for the CODA clinical terminology API (v1).
//!
//! Blocking client on `ureq`; responses are `serde_json::Value` with the API's own field names.
//! See ../README.md for the contract shared by all CODA SDKs.

use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

/// An RFC 7807 problem returned by CODA, with its stable error code.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub detail: String,
    pub correlation_id: Option<String>,
    pub retryable: bool,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status, self.detail)
    }
}

impl std::error::Error for ApiError {}

/// A code system, optionally pinned to a release.
#[derive(Debug, Clone, Serialize)]
pub struct SystemRef {
    pub system: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl SystemRef {
    pub fn new(system: impl Into<String>) -> Self {
        Self { system: system.into(), version: None }
    }
}

/// One coding to validate.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingItem {
    pub system: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_set_url: Option<String>,
}

type TokenFn = Arc<dyn Fn() -> String + Send + Sync>;

/// Thread-safe client; clone it freely.
#[derive(Clone)]
pub struct Client {
    base: String,
    token: TokenFn,
    max_retries: u32,
    agent: ureq::Agent,
}

impl Client {
    /// A client with a fixed bearer token.
    pub fn new(base_url: &str, token: &str) -> Self {
        let t = token.to_string();
        Self::with_token_provider(base_url, move || t.clone())
    }

    /// A client whose token provider is called before every request (refresh tokens here).
    pub fn with_token_provider(base_url: &str, token: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self {
            base: base_url.trim_end_matches('/').to_string(),
            token: Arc::new(token),
            max_retries: 2,
            agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build(),
        }
    }

    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.agent = ureq::AgentBuilder::new().timeout(timeout).build();
        self
    }

    pub fn systems(&self) -> Result<Value, ApiError> {
        self.send("GET", "/api/v1/systems", None, None)
    }

    pub fn lookup(&self, system: &str, code: &str, version: Option<&str>) -> Result<Value, ApiError> {
        let mut q = vec![("system", system), ("code", code)];
        if let Some(v) = version {
            q.push(("version", v));
        }
        self.send("GET", &format!("/api/v1/concepts/lookup?{}", query(&q)), None, None)
    }

    pub fn search(&self, query_text: &str, systems: &[SystemRef], count: Option<u32>) -> Result<Value, ApiError> {
        let mut body = json!({ "query": query_text, "systems": systems });
        if let Some(c) = count {
            body["count"] = json!(c);
        }
        self.send("POST", "/api/v1/search", Some(Body::Json(body)), None)
    }

    pub fn validate(&self, item: &CodingItem) -> Result<Value, ApiError> {
        self.send("POST", "/api/v1/codes/validate", Some(Body::Json(json!(item))), None)
    }

    pub fn validate_batch(&self, items: &[CodingItem]) -> Result<Value, ApiError> {
        self.send("POST", "/api/v1/codes/validate-batch", Some(Body::Json(json!({ "items": items }))), None)
    }

    /// Validates every Coding in a FHIR R4 resource or Bundle (JSON text).
    pub fn validate_fhir(&self, resource_json: &str, value_set: Option<&str>) -> Result<Value, ApiError> {
        let path = match value_set {
            Some(vs) => format!("/api/v1/codes/validate-fhir?{}", query(&[("valueSet", vs)])),
            None => "/api/v1/codes/validate-fhir".to_string(),
        };
        self.send("POST", &path, Some(Body::Raw(resource_json.to_string(), "application/fhir+json")), None)
    }

    pub fn expand(&self, value_set: &str, filter: Option<&str>, offset: u32, count: Option<u32>) -> Result<Value, ApiError> {
        let mut body = json!({ "valueSet": value_set, "offset": offset });
        if let Some(f) = filter {
            body["filter"] = json!(f);
        }
        if let Some(c) = count {
            body["count"] = json!(c);
        }
        self.send("POST", "/api/v1/expand", Some(Body::Json(body)), None)
    }

    pub fn translate(&self, system: &str, code: &str) -> Result<Value, ApiError> {
        self.send("POST", "/api/v1/translate", Some(Body::Json(json!({ "system": system, "code": code }))), None)
    }

    /// Grounded suggestions for a clinical phrase. Every candidate needs human review.
    pub fn analyze_phrase(&self, phrase: &str, systems: &[SystemRef]) -> Result<Value, ApiError> {
        let r = self.send("POST", "/api/v1/phrases/analyze", Some(Body::Json(json!({ "phrase": phrase, "systems": systems }))), None)?;
        Ok(r.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Records a human-reviewed decision; reuse the key when retrying the same decision.
    pub fn record_decision(&self, request: &Value, idempotency_key: &str) -> Result<Value, ApiError> {
        if idempotency_key.is_empty() {
            return Err(local_error("idempotency_key is required"));
        }
        self.send("POST", "/api/v1/decisions", Some(Body::Json(request.clone())), Some(idempotency_key))
    }

    fn send(&self, method: &str, path: &str, body: Option<Body>, idem: Option<&str>) -> Result<Value, ApiError> {
        let request_id = format!("{:032x}", rand::thread_rng().gen::<u128>());
        let mut attempt = 0;
        loop {
            let mut req = self
                .agent
                .request(method, &format!("{}{}", self.base, path))
                .set("Authorization", &format!("Bearer {}", (self.token)()))
                .set("Accept", "application/json")
                .set("X-Request-Id", &request_id);
            if let Some(k) = idem {
                req = req.set("Idempotency-Key", k);
            }
            let result = match &body {
                None => req.call(),
                Some(Body::Json(v)) => req.send_json(v.clone()),
                Some(Body::Raw(text, media)) => req.set("Content-Type", media).send_string(text),
            };
            match result {
                Ok(resp) => {
                    return resp.into_json::<Value>().map_err(|e| ApiError {
                        status: 200,
                        code: "MALFORMED_RESPONSE".into(),
                        detail: e.to_string(),
                        correlation_id: Some(request_id.clone()),
                        retryable: false,
                    })
                }
                Err(ureq::Error::Status(status, resp)) => {
                    let retry_after = resp.header("Retry-After").map(str::to_string);
                    let error = problem(status, resp.into_string().unwrap_or_default(), &request_id);
                    if attempt < self.max_retries && (status == 429 || status == 503) {
                        std::thread::sleep(backoff(attempt, retry_after.as_deref()));
                        attempt += 1;
                        continue;
                    }
                    return Err(error);
                }
                Err(e) => {
                    if attempt < self.max_retries {
                        std::thread::sleep(backoff(attempt, None));
                        attempt += 1;
                        continue;
                    }
                    return Err(ApiError {
                        status: 0,
                        code: "NETWORK_ERROR".into(),
                        detail: format!("The CODA API could not be reached: {e}"),
                        correlation_id: Some(request_id),
                        retryable: true,
                    });
                }
            }
        }
    }
}

enum Body {
    Json(Value),
    Raw(String, &'static str),
}

fn problem(status: u16, text: String, request_id: &str) -> ApiError {
    let p: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_string);
    ApiError {
        status,
        code: s("code").unwrap_or_else(|| format!("HTTP_{status}")),
        detail: s("detail").or_else(|| s("title")).unwrap_or_else(|| "Request failed.".into()),
        correlation_id: s("correlationId").or_else(|| Some(request_id.to_string())),
        retryable: p.get("retryable").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn backoff(attempt: u32, retry_after: Option<&str>) -> Duration {
    let mut ms = 250f64 * 2f64.powi(attempt as i32);
    if let Some(secs) = retry_after.and_then(|v| v.trim().parse::<f64>().ok()) {
        ms = secs * 1000.0;
    }
    Duration::from_millis(ms.clamp(0.0, 10_000.0) as u64)
}

fn query(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", k, encode(v))).collect::<Vec<_>>().join("&")
}

/// Percent-encodes everything except RFC 3986 unreserved characters.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn local_error(detail: &str) -> ApiError {
    ApiError { status: 0, code: "INVALID_ARGUMENT".into(), detail: detail.into(), correlation_id: None, retryable: false }
}
