"""Pfade und App-weite Konstanten."""
from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "AnimeGallery"
USER_AGENT = "AnimeGallery/0.1 (+desktop)"

VIDEO_EXTENSIONS = frozenset({".mkv", ".mp4", ".avi", ".webm", ".m4v", ".mov", ".ts", ".wmv"})


def data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".local" / "share")
    path = Path(base) / APP_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def library_file() -> Path:
    return data_dir() / "library.json"


def sources_file() -> Path:
    return data_dir() / "sources.json"


def image_cache_dir() -> Path:
    path = data_dir() / "cache" / "images"
    path.mkdir(parents=True, exist_ok=True)
    return path
