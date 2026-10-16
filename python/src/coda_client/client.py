"""Client for the CODA clinical terminology API (v1). Standard library only.

See ../../README.md for the contract shared by all CODA SDKs.
"""

from __future__ import annotations

import email.utils
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Union

TokenProvider = Union[str, Callable[[], str]]
JSON = Dict[str, Any]

_RETRYABLE = {429, 503}


class CodaApiError(Exception):
    """An RFC 7807 problem returned by CODA, with its stable error code."""

    def __init__(self, status: int, code: str, detail: str, correlation_id: Optional[str], retryable: bool) -> None:
        super().__init__(f"{code} ({status}): {detail}")
        self.status = status
        self.code = code
        self.detail = detail
        self.correlation_id = correlation_id
        self.retryable = retryable


class _Raw:
    def __init__(self, text: str, media_type: str) -> None:
        self.text = text
        self.media_type = media_type


class CodaClient:
    """Thread-safe client. Responses are dicts with the API's own (camelCase) field names."""

    def __init__(self, base_url: str, token: TokenProvider, *, timeout: float = 30.0, max_retries: int = 2) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._max_retries = max_retries

    # Operations -------------------------------------------------------------------------

    def systems(self) -> List[JSON]:
        return self._send("GET", "/api/v1/systems")

    def lookup(self, system: str, code: str, version: Optional[str] = None) -> JSON:
        return self._send("GET", "/api/v1/concepts/lookup?" + _query(system=system, code=code, version=version))

    def search(self, query: str, systems: Iterable[Union[str, Mapping[str, str]]], *, count: Optional[int] = None,
               include_inactive: Optional[bool] = None) -> JSON:
        return self._send("POST", "/api/v1/search", _clean({
            "query": query, "systems": [_system(s) for s in systems], "count": count, "includeInactive": include_inactive}))

    def validate(self, system: str, code: str, *, version: Optional[str] = None, display: Optional[str] = None,
                 value_set_url: Optional[str] = None) -> JSON:
        return self._send("POST", "/api/v1/codes/validate", _clean({
            "system": system, "code": code, "version": version, "display": display, "valueSetUrl": value_set_url}))

    def validate_batch(self, items: Iterable[Mapping[str, Any]]) -> JSON:
        return self._send("POST", "/api/v1/codes/validate-batch", {"items": [dict(i) for i in items]})

    def validate_fhir(self, resource: Union[str, Mapping[str, Any]], value_set: Optional[str] = None) -> JSON:
        """Validates every Coding in a FHIR R4 resource or Bundle (dict or JSON text)."""
        text = resource if isinstance(resource, str) else json.dumps(resource)
        path = "/api/v1/codes/validate-fhir" + ("?" + _query(valueSet=value_set) if value_set else "")
        return self._send("POST", path, _Raw(text, "application/fhir+json"))

    def expand(self, value_set: str, *, filter: Optional[str] = None, offset: Optional[int] = None,
               count: Optional[int] = None) -> JSON:
        return self._send("POST", "/api/v1/expand", _clean({"valueSet": value_set, "filter": filter, "offset": offset, "count": count}))

    def translate(self, system: str, code: str) -> JSON:
        return self._send("POST", "/api/v1/translate", {"system": system, "code": code})

    def analyze_phrase(self, phrase: str, systems: Iterable[Union[str, Mapping[str, str]]]) -> JSON:
        """Grounded suggestions for a clinical phrase. Every candidate needs human review."""
        return self._send("POST", "/api/v1/phrases/analyze", {"phrase": phrase, "systems": [_system(s) for s in systems]})["result"]

    def record_decision(self, request: Mapping[str, Any], idempotency_key: str) -> JSON:
        """Records a human-reviewed decision; reuse the idempotency key when retrying the same decision."""
        if not idempotency_key:
            raise ValueError("idempotency_key is required")
        return self._send("POST", "/api/v1/decisions", dict(request), {"Idempotency-Key": idempotency_key})

    # Transport --------------------------------------------------------------------------

    def _send(self, method: str, path: str, body: Any = None, extra: Optional[Mapping[str, str]] = None) -> Any:
        request_id = uuid.uuid4().hex
        attempt = 0
        while True:
            token = self._token() if callable(self._token) else self._token
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "X-Request-Id": request_id, **(extra or {})}
            data = None
            if isinstance(body, _Raw):
                headers["Content-Type"] = body.media_type
                data = body.text.encode("utf-8")
            elif body is not None:
                headers["Content-Type"] = "application/json"
                data = json.dumps(body).encode("utf-8")

            req = urllib.request.Request(self._base_url + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                error = _problem(e, request_id)
                if attempt < self._max_retries and e.code in _RETRYABLE:
                    time.sleep(_backoff(attempt, e.headers.get("Retry-After")))
                    attempt += 1
                    continue
                raise error from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < self._max_retries:
                    time.sleep(_backoff(attempt, None))
                    attempt += 1
                    continue
                raise CodaApiError(0, "NETWORK_ERROR", f"The CODA API could not be reached: {e}", request_id, True) from None


def _problem(e: urllib.error.HTTPError, request_id: str) -> CodaApiError:
    try:
        p = json.loads(e.read().decode("utf-8") or "{}")
    except ValueError:
        p = {}
    if not isinstance(p, dict):
        p = {}
    detail = p.get("detail") or p.get("title") or e.reason or "Request failed."
    return CodaApiError(e.code, p.get("code") or f"HTTP_{e.code}", str(detail), p.get("correlationId") or request_id, p.get("retryable") is True)


def _backoff(attempt: int, retry_after: Optional[str]) -> float:
    seconds = 0.25 * (2 ** attempt)
    if retry_after:
        try:
            seconds = float(retry_after)
        except ValueError:
            parsed = email.utils.parsedate_to_datetime(retry_after)
            seconds = parsed.timestamp() - time.time() if parsed else seconds
    return min(max(seconds, 0.0), 10.0)


def _query(**params: Optional[str]) -> str:
    return urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}, quote_via=urllib.parse.quote)


def _clean(d: Mapping[str, Any]) -> JSON:
    return {k: v for k, v in d.items() if v is not None}


def _system(s: Union[str, Mapping[str, str]]) -> Mapping[str, str]:
    return {"system": s} if isinstance(s, str) else dict(s)
