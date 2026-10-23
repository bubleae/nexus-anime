"""Wiedergabequellen: Wie wird aus einer Folge eine abspielbare URL?

Jeder ``StreamResolver`` prüft eine Art von Quelle. Die ``ResolverChain``
fragt sie der Reihe nach ab – lokale Datei vor Netzwerkstream. Eigene Quellen
(z. B. Jellyfin-/Plex-API des eigenen Servers) werden als weiterer Resolver
ergänzt.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import unicodedata
import uuid
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlsplit

import httpx

from anime_gallery.core.http import HttpClientProvider
from anime_gallery.core.models import Episode, Season, Series

log = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class PlaybackItem:
    url: str  # Dateipfad oder http(s)-URL, z. B. .m3u8 (HLS)
    title: str
    source: str


class StreamResolver(ABC):
    name: str

    @abstractmethod
    async def resolve(self, series: Series, season: Season, episode: Episode) -> PlaybackItem | None: ...


class LocalFileResolver(StreamResolver):
    name = "Lokal"

    async def resolve(self, series: Series, season: Season, episode: Episode) -> PlaybackItem | None:
        if episode.local_path and await asyncio.to_thread(Path(episode.local_path).is_file):
            return PlaybackItem(episode.local_path, f"{series.title} · {episode.label}", self.name)
        return None


class DirectUrlResolver(StreamResolver):
    """Vom Nutzer hinterlegte URL (HLS/DASH/MP4) – mpv/VLC spielen HLS nativ ab."""

    name = "Stream"

    async def resolve(self, series: Series, season: Season, episode: Episode) -> PlaybackItem | None:
        if episode.stream_url and episode.stream_url.startswith(("http://", "https://")):
            return PlaybackItem(episode.stream_url, f"{series.title} · {episode.label}", self.name)
        return None


# --------------------------------------------------------------------------- Eigene Links

@dataclass(slots=True)
class SourceConfig:
    """Vom Nutzer angelegte Quelle: ein Link mit Platzhaltern, z. B.
    ``https://mein-server/anime/{slug}/S{season:02d}E{episode:02d}.m3u8``."""

    name: str
    template: str
    enabled: bool = True
    id: str = field(default_factory=lambda: uuid.uuid4().hex)


PLACEHOLDERS = {
    "{title}": "Titel (URL-kodiert)",
    "{slug}": "Titel als kleinschreibung-mit-bindestrichen",
    "{season}": "Staffelnummer",
    "{episode}": "Folgennummer",
    "{episode:02d}": "Folgennummer zweistellig (03)",
    "{anilist_id}": "AniList-ID der Staffel",
}


def _slug(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def render_template(template: str, title: str, season: int, episode: int, anilist_id: int) -> str:
    """Wirft ValueError mit verständlicher Meldung bei kaputter Vorlage."""
    values = {"title": quote(title), "slug": _slug(title), "season": season,
              "episode": episode, "anilist_id": anilist_id}
    try:
        return template.format_map(values)
    except KeyError as exc:
        raise ValueError(f"Unbekannter Platzhalter {{{exc.args[0]}}}") from exc
    except (ValueError, IndexError) as exc:
        raise ValueError(f"Ungültige Vorlage: {exc}") from exc


def preview_template(template: str) -> str:
    return render_template(template, "Frieren: Beyond Journey’s End", 1, 3, 154587)


class SourceStore:
    """Liste der eigenen Quellen (JSON). Änderungen nur aus dem UI-Thread."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._items: list[SourceConfig] = []
        self._listeners: list[Callable[[], None]] = []
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                self._items = [SourceConfig(**s) for s in raw.get("sources", [])]
            except (OSError, ValueError, TypeError):
                log.exception("sources.json beschädigt – wird ignoriert")

    @property
    def items(self) -> list[SourceConfig]:
        return list(self._items)

    def subscribe(self, listener: Callable[[], None]) -> None:
        self._listeners.append(listener)

    def add(self, name: str, template: str) -> SourceConfig:
        name, template = name.strip(), template.strip()
        if not template.startswith(("http://", "https://")):
            raise ValueError("Der Link muss mit http:// oder https:// beginnen")
        preview_template(template)  # validiert Platzhalter
        source = SourceConfig(name or urlsplit(template).hostname or "Quelle", template)
        self._items.append(source)
        self._save()
        return source

    def remove(self, source_id: str) -> None:
        self._items = [s for s in self._items if s.id != source_id]
        self._save()

    def set_enabled(self, source_id: str, enabled: bool) -> None:
        for source in self._items:
            if source.id == source_id:
                source.enabled = enabled
        self._save()

    def move(self, source_id: str, delta: int) -> None:
        index = next(i for i, s in enumerate(self._items) if s.id == source_id)
        target = max(0, min(len(self._items) - 1, index + delta))
        self._items.insert(target, self._items.pop(index))
        self._save()

    def _save(self) -> None:
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"sources": [asdict(s) for s in self._items]}, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, self._path)
        for listener in list(self._listeners):
            listener()


class TemplateSourceResolver(StreamResolver):
    """Probiert alle aktiven eigenen Links der Reihe nach; nimmt den ersten, der antwortet."""

    name = "Eigene Links"

    def __init__(self, store: SourceStore, http: HttpClientProvider) -> None:
        self._store = store
        self._http = http

    async def resolve(self, series: Series, season: Season, episode: Episode) -> PlaybackItem | None:
        season_number = next((i + 1 for i, s in enumerate(series.seasons) if s is season), 1)
        for source in self._store.items:
            if not source.enabled:
                continue
            try:
                url = render_template(source.template, series.title, season_number, episode.number, season.anilist_id)
            except ValueError:
                continue
            if await self._reachable(url):
                return PlaybackItem(url, f"{series.title} · {episode.label}", source.name)
            log.info("Quelle %s: nicht erreichbar (%s)", source.name, url)
        return None

    async def _reachable(self, url: str) -> bool:
        client = self._http.get()
        try:
            resp = await client.head(url, timeout=6.0)
            if resp.status_code in (403, 405, 501):  # manche Server erlauben kein HEAD
                async with client.stream("GET", url, timeout=6.0) as streamed:
                    return streamed.status_code < 400
            return resp.status_code < 400
        except httpx.HTTPError:
            return False


class ResolverChain:
    def __init__(self, resolvers: list[StreamResolver]) -> None:
        self._resolvers = resolvers

    async def resolve(self, series: Series, season: Season, episode: Episode) -> PlaybackItem | None:
        for resolver in self._resolvers:
            try:
                item = await resolver.resolve(series, season, episode)
            except Exception:
                log.exception("Resolver %s fehlgeschlagen", resolver.name)
                continue
            if item is not None:
                return item
        return None
