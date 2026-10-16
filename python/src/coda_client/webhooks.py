"""Verification of CODA webhooks (Standard Webhooks signatures)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Mapping, Optional


def verify_webhook(secret: str, headers: Mapping[str, str], body: str, *, tolerance_seconds: int = 300,
                   now: Optional[float] = None) -> bool:
    """True when the delivery was signed by CODA with ``secret`` ("whsec_...") and is recent.

    Pass the raw request body exactly as received, and the request headers (any case).
    """
    lower = {k.lower(): v for k, v in headers.items()}
    msg_id, timestamp, signature = lower.get("webhook-id"), lower.get("webhook-timestamp"), lower.get("webhook-signature")
    if not msg_id or not timestamp or not signature:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    current = time.time() if now is None else now
    if abs(current - ts) > tolerance_seconds:
        return False

    key = base64.b64decode(secret[len("whsec_"):] if secret.startswith("whsec_") else secret)
    mac = hmac.new(key, f"{msg_id}.{timestamp}.{body}".encode("utf-8"), hashlib.sha256).digest()
    expected = "v1," + base64.b64encode(mac).decode("ascii")
    return any(hmac.compare_digest(candidate, expected) for candidate in signature.split(" "))
