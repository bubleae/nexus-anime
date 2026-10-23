"""Such- und Metadaten-Modul.

``MetadataProvider`` ist die Schnittstelle, ``AniListProvider`` die Umsetzung
über die öffentliche AniList-GraphQL-API (kein API-Key nötig, ~90 Req./Min.).
Weitere Anbieter (Jikan/MyAnimeList, Kitsu, TMDB) lassen sich als eigene
Klasse ergänzen, ohne die UI anzufassen.
"""
from __future__ import annotations

import asyncio
import html
import re
import time
from abc import ABC, abstractmethod
from typing import Any

import httpx

from anime_gallery.core.http import HttpClientProvider
from anime_gallery.core.models import AnimeDetails, AnimeSummary, Episode, Relation, SearchPage


class MetadataError(Exception):
    """Fehler, der dem Nutzer direkt angezeigt werden kann."""


class MetadataProvider(ABC):
    @abstractmethod
    async def search(self, query: str, page: int = 1) -> SearchPage: ...

    @abstractmethod
    async def details(self, anime_id: int) -> AnimeDetails: ...


_SUMMARY_FIELDS = """
  id
  title { romaji english }
  coverImage { large }
  seasonYear format episodes averageScore
"""

SEARCH_QUERY = f"""
query ($search: String, $page: Int, $perPage: Int) {{
  Page(page: $page, perPage: $perPage) {{
    pageInfo {{ hasNextPage }}
    media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {{ {_SUMMARY_FIELDS} }}
  }}
}}"""

DETAILS_QUERY = f"""
query ($id: Int) {{
  Media(id: $id, type: ANIME) {{
    id
    title {{ romaji english native }}
    description(asHtml: false)
    coverImage {{ extraLarge large }}
    bannerImage genres status seasonYear format episodes averageScore
    streamingEpisodes {{ title thumbnail }}
    relations {{
      edges {{
        relationType(version: 2)
        node {{ type {_SUMMARY_FIELDS} }}
      }}
    }}
  }}
}}"""

RELEVANT_RELATIONS = {"SEQUEL", "PREQUEL", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE", "PARENT"}
_EPISODE_TITLE = re.compile(r"Episode\s+(\d+)\s*[-–:]?\s*(.*)", re.IGNORECASE)


def _clean_description(text: str | None) -> str:
    if not text:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _summary(media: dict[str, Any]) -> AnimeSummary:
    title = media.get("title") or {}
    return AnimeSummary(
        anilist_id=media["id"],
        title=title.get("english") or title.get("romaji") or "Unbenannt",
        cover_url=(media.get("coverImage") or {}).get("large"),
        year=media.get("seasonYear"),
        format=media.get("format"),
        episodes=media.get("episodes"),
        score=media.get("averageScore"),
    )


def _episodes(total: int | None, streaming: list[dict[str, Any]] | None) -> list[Episode]:
    """AniList liefert nur die Anzahl; Titel/Thumbnails kommen – falls vorhanden –
    aus den offiziellen ``streamingEpisodes`` (Crunchyroll & Co.)."""
    known: dict[int, tuple[str, str | None]] = {}
    for item in streaming or []:
        match = _EPISODE_TITLE.match(item.get("title") or "")
        if match:
            known[int(match[1])] = (match[2].strip(), item.get("thumbnail"))
    count = max([total or 0, *known])
    return [
        Episode(number=n, title=known.get(n, ("", None))[0], thumbnail=known.get(n, ("", None))[1])
        for n in range(1, count + 1)
    ]


class AniListProvider(MetadataProvider):
    URL = "https://graphql.anilist.co"
    PER_PAGE = 30

    def __init__(self, http: HttpClientProvider, cache_ttl: float = 600.0) -> None:
        self._http = http
        self._cache_ttl = cache_ttl
        self._details_cache: dict[int, tuple[float, AnimeDetails]] = {}

    async def _query(self, query: str, variables: dict[str, Any], retries: int = 2) -> dict[str, Any]:
        for attempt in range(retries + 1):
            try:
                resp = await self._http.get().post(self.URL, json={"query": query, "variables": variables})
            except httpx.HTTPError as exc:
                raise MetadataError(f"Netzwerkfehler: {exc}") from exc
            if resp.status_code == 429 and attempt < retries:
                await asyncio.sleep(float(resp.headers.get("Retry-After", "2")))
                continue
            try:
                payload = resp.json()
            except ValueError as exc:
                raise MetadataError(f"AniList antwortete mit HTTP {resp.status_code}") from exc
            if payload.get("errors"):
                raise MetadataError(payload["errors"][0].get("message", "Unbekannter AniList-Fehler"))
            if resp.status_code >= 400:
                raise MetadataError(f"AniList antwortete mit HTTP {resp.status_code}")
            return payload["data"]
        raise MetadataError("AniList: Rate-Limit erreicht, bitte kurz warten")

    async def search(self, query: str, page: int = 1) -> SearchPage:
        data = await self._query(SEARCH_QUERY, {"search": query, "page": page, "perPage": self.PER_PAGE})
        page_data = data["Page"]
        return SearchPage(
            items=[_summary(m) for m in page_data["media"]],
            page=page,
            has_next=bool(page_data["pageInfo"]["hasNextPage"]),
        )

    async def details(self, anime_id: int) -> AnimeDetails:
        cached = self._details_cache.get(anime_id)
        if cached and time.monotonic() - cached[0] < self._cache_ttl:
            return cached[1]

        media = (await self._query(DETAILS_QUERY, {"id": anime_id}))["Media"]
        title = media.get("title") or {}
        cover = media.get("coverImage") or {}
        relations = [
            Relation(edge["relationType"], _summary(edge["node"]))
            for edge in (media.get("relations") or {}).get("edges", [])
            if edge["node"].get("type") == "ANIME" and edge.get("relationType") in RELEVANT_RELATIONS
        ]
        details = AnimeDetails(
            anilist_id=media["id"],
            title=title.get("english") or title.get("romaji") or "Unbenannt",
            title_native=title.get("native"),
            description=_clean_description(media.get("description")),
            cover_url=cover.get("extraLarge") or cover.get("large"),
            banner_url=media.get("bannerImage"),
            genres=media.get("genres") or [],
            status=media.get("status"),
            year=media.get("seasonYear"),
            format=media.get("format"),
            score=media.get("averageScore"),
            episodes=_episodes(media.get("episodes"), media.get("streamingEpisodes")),
            relations=relations,
        )
        self._details_cache[anime_id] = (time.monotonic(), details)
        return details
