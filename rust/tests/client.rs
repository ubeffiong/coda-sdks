use coda_client::{Client, Clinician, CodingItem, ConnectSessionRequest, SystemRef};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    uri: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Minimal HTTP/1.1 server replaying scripted responses (one request per connection).
fn mock(replies: Vec<(u16, &'static str, Option<&'static str>)>) -> (String, Arc<Mutex<Vec<Recorded>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let log2 = log.clone();
    thread::spawn(move || {
        for (status, body, retry_after) in replies {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut parts = line.split_whitespace();
            let (method, uri) = (parts.next().unwrap().to_string(), parts.next().unwrap().to_string());
            let mut headers = Vec::new();
            let mut len = 0;
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                let h = h.trim_end().to_string();
                if h.is_empty() {
                    break;
                }
                let (k, v) = h.split_once(':').unwrap();
                if k.eq_ignore_ascii_case("content-length") {
                    len = v.trim().parse().unwrap();
                }
                headers.push((k.trim().to_string(), v.trim().to_string()));
            }
            let mut buf = vec![0; len];
            reader.read_exact(&mut buf).unwrap();
            log2.lock().unwrap().push(Recorded { method, uri, headers, body: String::from_utf8(buf).unwrap() });
            let extra = retry_after.map(|r| format!("Retry-After: {r}\r\n")).unwrap_or_default();
            let resp = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(resp.as_bytes()).unwrap();
        }
    });
    (url, log)
}

#[test]
fn search_posts_query_with_auth_and_request_id() {
    let (url, log) = mock(vec![(200, r#"{"requestId":"r1","groups":[]}"#, None)]);
    let r = Client::new(&format!("{url}/"), "tok-1").search("type 2 diabetes", &[SystemRef::new("urn:coda:fixture:clinical")], Some(5)).unwrap();
    assert_eq!(r["requestId"], "r1");
    let req = log.lock().unwrap()[0].clone();
    assert_eq!((req.method.as_str(), req.uri.as_str()), ("POST", "/api/v1/search"));
    assert_eq!(req.header("Authorization"), Some("Bearer tok-1"));
    assert!(req.header("X-Request-Id").is_some());
    let body: Value = serde_json::from_str(&req.body).unwrap();
    assert_eq!(body, json!({"query": "type 2 diabetes", "systems": [{"system": "urn:coda:fixture:clinical"}], "count": 5}));
}

#[test]
fn lookup_encodes_query() {
    let (url, log) = mock(vec![(200, r#"{"code":"1A00"}"#, None)]);
    Client::new(&url, "t").lookup("http://id.who.int/icd/release/11/mms", "1A00", Some("2025-01")).unwrap();
    assert_eq!(log.lock().unwrap()[0].uri, "/api/v1/concepts/lookup?system=http%3A%2F%2Fid.who.int%2Ficd%2Frelease%2F11%2Fmms&code=1A00&version=2025-01");
}

#[test]
fn problems_become_errors_without_retry() {
    let (url, log) = mock(vec![(422, r#"{"code":"UNKNOWN_CODE_SYSTEM","detail":"not registered","correlationId":"c-1","retryable":false}"#, None)]);
    let err = Client::new(&url, "t").validate(&CodingItem { system: "urn:nope".into(), code: "X".into(), ..Default::default() }).unwrap_err();
    assert_eq!((err.status, err.code.as_str(), err.correlation_id.as_deref(), err.retryable), (422, "UNKNOWN_CODE_SYSTEM", Some("c-1"), false));
    assert_eq!(log.lock().unwrap().len(), 1);
}

#[test]
fn rate_limit_retried_with_same_request_id() {
    let (url, log) = mock(vec![(429, r#"{"code":"RATE_LIMITED","retryable":true}"#, Some("0")), (200, r#"{"outcome":"valid"}"#, None)]);
    let r = Client::new(&url, "t").validate(&CodingItem { system: "urn:coda:fixture:clinical".into(), code: "FX-111200".into(), ..Default::default() }).unwrap();
    assert_eq!(r["outcome"], "valid");
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].header("X-Request-Id"), log[1].header("X-Request-Id"));
}

#[test]
fn gives_up_after_max_retries() {
    let down = (503, r#"{"code":"TERMINOLOGY_PROVIDER_UNAVAILABLE","retryable":true}"#, Some("0"));
    let (url, log) = mock(vec![down, down]);
    let err = Client::new(&url, "t").max_retries(1).systems().unwrap_err();
    assert_eq!(err.code, "TERMINOLOGY_PROVIDER_UNAVAILABLE");
    assert_eq!(log.lock().unwrap().len(), 2);
}

#[test]
fn fhir_and_decision_headers() {
    let (url, log) = mock(vec![(200, r#"{"summary":{"total":0}}"#, None), (201, r#"{"id":"d1"}"#, None)]);
    let client = Client::new(&url, "t");
    client.validate_fhir(r#"{"resourceType":"Bundle","type":"collection","entry":[]}"#, Some("idsr-immediate")).unwrap();
    client.record_decision(&json!({"purpose": "diagnosis", "outcome": "approved"}), "idem-42").unwrap();
    let log = log.lock().unwrap();
    assert_eq!(log[0].header("Content-Type"), Some("application/fhir+json"));
    assert_eq!(log[0].uri, "/api/v1/codes/validate-fhir?valueSet=idsr-immediate");
    assert_eq!(log[1].header("Idempotency-Key"), Some("idem-42"));
}

#[test]
fn verify_webhook_shared_vector() {
    use coda_client::verify_webhook;
    let secret = "whsec_Y29kYS10ZXN0LXdlYmhvb2stc2VjcmV0LTMyYnl0ZXM=";
    let id = "0198f1a2-0000-7000-8000-000000000001";
    let sig = "v0,old v1,iBHZWsokVTH0FJlTSGXVgcKqbLZN1NklHSqCNCG733Q=";
    let body = r#"{"id":"0198f1a2-0000-7000-8000-000000000001","type":"webhook.ping","data":{"message":"CODA webhook test"}}"#;
    assert!(verify_webhook(secret, id, "1792100000", sig, body, 1792100000, 300));
    assert!(!verify_webhook(secret, id, "1792100000", sig, &format!("{body} "), 1792100000, 300));
    assert!(!verify_webhook(secret, id, "1792100000", sig, body, 1792100000 + 600, 300));
    assert!(!verify_webhook("whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", id, "1792100000", sig, body, 1792100000, 300));
}

#[test]
fn opens_a_connect_session_and_launches_the_clinician() {
    let (url, log) = mock(vec![
        (201, r#"{"id":"s-1","launchUrl":"https://coda.test/connect?session=s-1&launch=coda_lc_x"}"#, None),
        (200, r#"{"id":"s-1","status":"completed","result":{"selections":[{"code":"5A11"}]}}"#, None),
    ]);
    let client = Client::new(&url, "coda_sk_integration-key");
    let s = client
        .open_connect_session(&ConnectSessionRequest {
            app_id: "app-1".into(),
            text: Some("type 2 diabetes".into()),
            patient_ref: Some("pt_3f2b8c1e".into()),
            clinician: Some(Clinician { reference: "usr_7c1d2e9a".into(), name: Some("Dr A. Bello".into()) }),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s["id"], "s-1");
    assert_eq!(client.get_connect_session("s-1").unwrap()["result"]["selections"][0]["code"], "5A11");
    let reqs = log.lock().unwrap().clone();
    assert_eq!((reqs[0].method.as_str(), reqs[0].uri.as_str()), ("POST", "/api/v1/connect/sessions"));
    assert_eq!(reqs[0].header("Authorization"), Some("Bearer coda_sk_integration-key"));
    let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
    assert_eq!(body, json!({"appId": "app-1", "text": "type 2 diabetes", "patientRef": "pt_3f2b8c1e", "clinician": {"ref": "usr_7c1d2e9a", "name": "Dr A. Bello"}}));
    assert_eq!(reqs[1].uri, "/api/v1/connect/sessions/s-1");
}
