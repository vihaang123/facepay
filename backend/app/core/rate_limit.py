"""Minimal in-memory sliding-window rate limiter.

Prototype-level only: state is per process, so it does not coordinate across
multiple instances and resets on restart. Behind a reverse proxy the client IP
seen here is the proxy's unless forwarded headers are trusted.
"""

import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import HTTPException, Request, status

from app.core.config import get_settings


class RateLimiter:
    def __init__(self, max_requests: int, window_seconds: int = 60, enabled: bool = True):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.enabled = enabled
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()

    def allow(self, key: str) -> bool:
        if not self.enabled:
            return True
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= self.max_requests:
                return False
            hits.append(now)
            return True


_settings = get_settings()
auth_limiter = RateLimiter(
    max_requests=_settings.auth_rate_limit_per_minute,
    enabled=_settings.rate_limit_enabled,
)


def limit_auth_attempts(request: Request) -> None:
    """FastAPI dependency for login and registration endpoints."""
    client_ip = request.client.host if request.client else "unknown"
    if not auth_limiter.allow(f"{request.url.path}:{client_ip}"):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please wait a minute and try again.",
            headers={"Retry-After": str(auth_limiter.window_seconds)},
        )
