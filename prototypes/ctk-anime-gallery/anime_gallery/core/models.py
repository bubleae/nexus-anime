"""Domänenmodelle.

* ``AnimeSummary`` / ``AnimeDetails`` – flüchtige Online-Metadaten (AniList).
* ``Series`` > ``Season`` > ``Episode`` – persistente Bibliothek. Eine Serie
  fasst mehrere AniList-Einträge (bei AniList ist jede Staffel ein eigener
  Eintrag) zu Staffeln zusammen.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field, fields
from typing import Any


def _pick(cls: type, data: dict[str, Any]) -> dict[str, Any]:
    names = {f.name for f in fields(cls)}
    return {k: v for k, v in data.items() if k in names}


# --------------------------------------------------------------------------- Bibliothek


@dataclass(slots=True)
class Episode:
    number: int
    title: str = ""
    thumbnail: str | None = None
    local_path: str | None = None
    stream_url: str | None = None  # z. B. HLS (.m3u8) vom eigenen Jellyfin/Plex-Server
    watched: bool = False

    @property
    def label(self) -> str:
        return f"Folge {self.number}" + (f" – {self.title}" if self.title else "")

    @property
    def has_source(self) -> bool:
        return bool(self.local_path or self.stream_url)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Episode:
        return cls(**_pick(cls, data))


@dataclass(slots=True)
class Season:
    anilist_id: int
    title: str
    year: int | None = None
    format: str | None = None
    episodes: list[Episode] = field(default_factory=list)
    folder: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Season:
        kwargs = _pick(cls, data)
        kwargs["episodes"] = [Episode.from_dict(e) for e in data.get("episodes", [])]
        return cls(**kwargs)


@dataclass(slots=True)
class Series:
    title: str
    seasons: list[Season]
    cover_url: str | None = None
    banner_url: str | None = None
    description: str = ""
    genres: list[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    added_at: float = field(default_factory=time.time)

    @property
    def episode_count(self) -> int:
        return sum(len(s.episodes) for s in self.seasons)

    @property
    def watched_count(self) -> int:
        return sum(e.watched for s in self.seasons for e in s.episodes)

    @property
    def has_local_files(self) -> bool:
        return any(e.local_path for s in self.seasons for e in s.episodes)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Series:
        kwargs = _pick(cls, data)
        kwargs["seasons"] = [Season.from_dict(s) for s in data.get("seasons", [])]
        return cls(**kwargs)


# --------------------------------------------------------------------------- Metadaten


@dataclass(slots=True, frozen=True)
class AnimeSummary:
    anilist_id: int
    title: str
    cover_url: str | None = None
    year: int | None = None
    format: str | None = None
    episodes: int | None = None
    score: int | None = None


@dataclass(slots=True, frozen=True)
class Relation:
    relation_type: str  # SEQUEL, PREQUEL, SIDE_STORY, …
    anime: AnimeSummary


@dataclass(slots=True, frozen=True)
class SearchPage:
    items: list[AnimeSummary]
    page: int
    has_next: bool


@dataclass(slots=True)
class AnimeDetails:
    anilist_id: int
    title: str
    title_native: str | None
    description: str
    cover_url: str | None
    banner_url: str | None
    genres: list[str]
    status: str | None
    year: int | None
    format: str | None
    score: int | None
    episodes: list[Episode]
    relations: list[Relation]

    def to_season(self) -> Season:
        return Season(
            anilist_id=self.anilist_id,
            title=self.title,
            year=self.year,
            format=self.format,
            episodes=[Episode(e.number, e.title, e.thumbnail) for e in self.episodes],
        )

    def to_series(self) -> Series:
        return Series(
            title=self.title,
            seasons=[self.to_season()],
            cover_url=self.cover_url,
            banner_url=self.banner_url,
            description=self.description,
            genres=list(self.genres),
        )
