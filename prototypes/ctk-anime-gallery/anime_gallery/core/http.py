"""Gemeinsamer httpx-Client (Connection-Pooling für alle Services)."""
from __future__ import annotations

import httpx

from anime_gallery.core.config import USER_AGENT


class HttpClientProvider:
    """Erzeugt den Client lazy – und damit garantiert im Loop des AsyncRunners."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    def get(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(15.0, connect=10.0),
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
                limits=httpx.Limits(max_connections=12, max_keepalive_connections=8),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
