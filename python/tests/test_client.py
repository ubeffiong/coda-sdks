import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from coda_client import CodaApiError, CodaClient  # noqa: E402


class Mock:
    """Local HTTP server replaying scripted responses and recording requests."""

    def __init__(self, script):
        self.script = list(script)
        self.requests = []
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode() if length else ""
                mock.requests.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
                status, payload, *extra = mock.script.pop(0)
                self.send_response(status)
                self.send_header("Content-Type", "application/json" if status < 400 else "application/problem+json")
                for k, v in (extra[0] if extra else {}).items():
                    self.send_header(k, v)
                data = json.dumps(payload).encode()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class CodaClientTests(unittest.TestCase):
    def test_search_posts_query_with_auth_and_request_id(self):
        m = Mock([(200, {"requestId": "r1", "groups": []})])
        r = CodaClient(m.url + "/", lambda: "tok-1").search("type 2 diabetes", ["urn:coda:fixture:clinical"], count=5)
        self.assertEqual(r["requestId"], "r1")
        req = m.requests[0]
        self.assertEqual((req["method"], req["path"]), ("POST", "/api/v1/search"))
        self.assertEqual(req["headers"]["Authorization"], "Bearer tok-1")
        self.assertIn("X-Request-Id", req["headers"])
        self.assertEqual(json.loads(req["body"]), {"query": "type 2 diabetes", "systems": [{"system": "urn:coda:fixture:clinical"}], "count": 5})
        m.close()

    def test_lookup_encodes_query(self):
        m = Mock([(200, {"code": "1A00"})])
        CodaClient(m.url, "t").lookup("http://id.who.int/icd/release/11/mms", "1A00", "2025-01")
        self.assertEqual(m.requests[0]["path"], "/api/v1/concepts/lookup?system=http%3A%2F%2Fid.who.int%2Ficd%2Frelease%2F11%2Fmms&code=1A00&version=2025-01")
        m.close()

    def test_problem_becomes_error_without_retry(self):
        m = Mock([(422, {"code": "UNKNOWN_CODE_SYSTEM", "detail": "not registered", "correlationId": "c-1", "retryable": False})])
        with self.assertRaises(CodaApiError) as ctx:
            CodaClient(m.url, "t").validate("urn:nope", "X")
        e = ctx.exception
        self.assertEqual((e.status, e.code, e.correlation_id, e.retryable), (422, "UNKNOWN_CODE_SYSTEM", "c-1", False))
        self.assertEqual(len(m.requests), 1)
        m.close()

    def test_rate_limit_retried_with_same_request_id(self):
        m = Mock([(429, {"code": "RATE_LIMITED", "retryable": True}, {"Retry-After": "0"}), (200, {"outcome": "valid"})])
        r = CodaClient(m.url, "t").validate("urn:coda:fixture:clinical", "FX-111200")
        self.assertEqual(r["outcome"], "valid")
        self.assertEqual(len(m.requests), 2)
        self.assertEqual(m.requests[0]["headers"]["X-Request-Id"], m.requests[1]["headers"]["X-Request-Id"])
        m.close()

    def test_gives_up_after_max_retries(self):
        down = (503, {"code": "TERMINOLOGY_PROVIDER_UNAVAILABLE", "retryable": True}, {"Retry-After": "0"})
        m = Mock([down, down])
        with self.assertRaises(CodaApiError) as ctx:
            CodaClient(m.url, "t", max_retries=1).systems()
        self.assertEqual(ctx.exception.code, "TERMINOLOGY_PROVIDER_UNAVAILABLE")
        self.assertEqual(len(m.requests), 2)
        m.close()

    def test_fhir_and_decision_headers(self):
        m = Mock([(200, {"summary": {"total": 0}}), (201, {"id": "d1"})])
        c = CodaClient(m.url, "t")
        c.validate_fhir({"resourceType": "Bundle", "type": "collection", "entry": []}, "idsr-immediate")
        c.record_decision({"purpose": "diagnosis", "outcome": "approved"}, "idem-42")
        self.assertEqual(m.requests[0]["headers"]["Content-Type"], "application/fhir+json")
        self.assertEqual(m.requests[0]["path"], "/api/v1/codes/validate-fhir?valueSet=idsr-immediate")
        self.assertEqual(m.requests[1]["headers"]["Idempotency-Key"], "idem-42")
        m.close()


if __name__ == "__main__":
    unittest.main()
