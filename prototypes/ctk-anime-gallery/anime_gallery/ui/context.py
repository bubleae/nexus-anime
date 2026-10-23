"""Abhängigkeiten, die jede View bekommt (statt globaler Singletons)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

from anime_gallery.core.async_runner import AsyncRunner
from anime_gallery.services.images import ImageService
from anime_gallery.services.library import LibraryRepository
from anime_gallery.services.metadata import MetadataProvider
from anime_gallery.services.sources import ResolverChain

NotifyLevel = Literal["info", "success", "error"]


@dataclass(slots=True)
class AppContext:
    runner: AsyncRunner
    metadata: MetadataProvider
    images: ImageService
    library: LibraryRepository
    resolvers: ResolverChain
    navigate: Callable[..., None]  # navigate(view_name, **kwargs)
    back: Callable[[], None]
    notify: Callable[[str, NotifyLevel], None]
    toggle_fullscreen: Callable[[], None]

    def info(self, text: str) -> None:
        self.notify(text, "info")

    def error(self, text: str | BaseException) -> None:
        self.notify(str(text), "error")

    def success(self, text: str) -> None:
        self.notify(text, "success")


class View:
    """Lebenszyklus-Hooks, die ``AnimeGalleryApp`` aufruft (alle optional)."""

    def on_show(self, **kwargs: Any) -> None: ...

    def on_resume(self) -> None: ...

    def on_hide(self) -> None: ...

    def handle_key(self, event: Any) -> bool:
        return False
