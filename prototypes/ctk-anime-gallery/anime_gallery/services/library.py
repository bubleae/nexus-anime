"""Mediathek-Persistenz (JSON) und Zuordnung lokaler Videodateien zu Folgen."""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Callable

from anime_gallery.core.config import VIDEO_EXTENSIONS
from anime_gallery.core.models import Series

log = logging.getLogger(__name__)


class LibraryRepository:
    """Hält alle Serien im Speicher und schreibt bei jeder Änderung atomar auf die Platte.

    Nur aus dem UI-Thread benutzen. Für sehr große Bibliotheken lässt sich die
    Klasse 1:1 durch eine SQLite-Variante mit derselben Schnittstelle ersetzen.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._items: dict[str, Series] = {}
        self._listeners: list[Callable[[], None]] = []
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            self._items = {s.id: s for s in (Series.from_dict(d) for d in raw.get("series", []))}
        except (OSError, ValueError, TypeError, KeyError):
            log.exception("Bibliothek beschädigt – Sicherung wird angelegt")
            os.replace(self._path, self._path.with_suffix(".corrupt.json"))

    def _save(self) -> None:
        tmp = self._path.with_suffix(".tmp")
        payload = {"version": 1, "series": [s.to_dict() for s in self._items.values()]}
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)
        for listener in list(self._listeners):
            listener()

    def subscribe(self, listener: Callable[[], None]) -> None:
        self._listeners.append(listener)

    def all(self) -> list[Series]:
        return sorted(self._items.values(), key=lambda s: s.title.casefold())

    def get(self, series_id: str) -> Series | None:
        return self._items.get(series_id)

    def contains(self, series_id: str) -> bool:
        return series_id in self._items

    def find_by_anilist(self, anilist_id: int) -> Series | None:
        return next((s for s in self._items.values() if any(x.anilist_id == anilist_id for x in s.seasons)), None)

    def upsert(self, series: Series) -> None:
        self._items[series.id] = series
        self._save()

    def remove(self, series_id: str) -> None:
        if self._items.pop(series_id, None) is not None:
            self._save()


# --------------------------------------------------------------------------- Ordner-Scan

_BRACKETS = re.compile(r"\[[^\]]*\]|\([^)]*\)")
_EPISODE_PATTERNS = [
    re.compile(r"S\d{1,2}\s*E(\d{1,4})", re.IGNORECASE),                       # S01E05
    re.compile(r"\b(?:EP?|Episode|Folge)[\s._-]*(\d{1,4})\b", re.IGNORECASE),   # E05, Ep 5, Folge 5
    re.compile(r"\s-\s*(\d{1,4})(?:v\d)?(?=[\s._]|$)"),                          # "Titel - 05"
    re.compile(r"(?:^|[\s._])(\d{1,3})(?=[\s._]|$)"),                            # "Titel 05"
]


def episode_number_from_filename(filename: str) -> int | None:
    stem = _BRACKETS.sub(" ", Path(filename).stem)  # [Gruppe], (1080p) usw. entfernen
    for pattern in _EPISODE_PATTERNS:
        match = pattern.search(stem)
        if match:
            return int(match.group(1))
    return None


def scan_folder(folder: Path) -> dict[int, str]:
    """Blockierend – über ``AsyncRunner.run_blocking`` aufrufen."""
    mapping: dict[int, str] = {}
    files = sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS)
    for file in files:
        number = episode_number_from_filename(file.name)
        if number is not None and number not in mapping:
            mapping[number] = str(file)
    return mapping
