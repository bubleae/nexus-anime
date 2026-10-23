"""Hauptfenster: Composition Root, Navigation, Sidebar, Statusleiste."""
from __future__ import annotations

from typing import Any

import customtkinter as ctk

from anime_gallery.core import config
from anime_gallery.core.async_runner import AsyncRunner
from anime_gallery.core.http import HttpClientProvider
from anime_gallery.services.images import ImageService
from anime_gallery.services.library import LibraryRepository
from anime_gallery.services.metadata import AniListProvider
from anime_gallery.services.sources import (
    DirectUrlResolver,
    LocalFileResolver,
    ResolverChain,
    SourceStore,
    TemplateSourceResolver,
)
from anime_gallery.ui import theme
from anime_gallery.ui.context import AppContext, NotifyLevel
from anime_gallery.ui.views.detail import DetailView
from anime_gallery.ui.views.library import LibraryView
from anime_gallery.ui.views.player import PlayerView
from anime_gallery.ui.views.search import SearchView
from anime_gallery.ui.views.sources import SourcesView

NAV_ITEMS = [("library", "▦  Bibliothek"), ("search", "⌕  Suche"), ("sources", "⛓  Quellen")]
NOTIFY_COLORS = {"info": theme.TEXT_MUTED, "success": theme.SUCCESS, "error": theme.DANGER}


class AnimeGalleryApp(ctk.CTk):
    def __init__(self) -> None:
        theme.apply()
        super().__init__(fg_color=theme.BG)
        self.title("Anime Gallery")
        self.geometry("1320x840")
        self.minsize(960, 620)

        # ---- Dienste verdrahten (einzige Stelle, die konkrete Klassen kennt)
        self._http = HttpClientProvider()
        self._runner = AsyncRunner(self)
        self._sources = SourceStore(config.sources_file())
        self.ctx = AppContext(
            runner=self._runner,
            metadata=AniListProvider(self._http),
            images=ImageService(self._http, config.image_cache_dir()),
            library=LibraryRepository(config.library_file()),
            resolvers=ResolverChain([
                LocalFileResolver(),
                DirectUrlResolver(),
                TemplateSourceResolver(self._sources, self._http),
            ]),
            navigate=self.navigate,
            back=self.back,
            notify=self.notify,
            toggle_fullscreen=self.toggle_fullscreen,
        )

        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)
        self._build_sidebar()

        self._content = ctk.CTkFrame(self, fg_color=theme.BG, corner_radius=0)
        self._content.grid(row=0, column=1, sticky="nsew")
        self._content.grid_columnconfigure(0, weight=1)
        self._content.grid_rowconfigure(0, weight=1)

        self._status = ctk.CTkLabel(self, text="", anchor="w", font=theme.font(12), text_color=theme.TEXT_MUTED,
                                    fg_color=theme.SURFACE, height=26)
        self._status.grid(row=1, column=0, columnspan=2, sticky="ew")
        self._status_clear_id: str | None = None

        self._views: dict[str, Any] = {
            "library": LibraryView(self._content, self.ctx),
            "search": SearchView(self._content, self.ctx),
            "detail": DetailView(self._content, self.ctx),
            "player": PlayerView(self._content, self.ctx),
            "sources": SourcesView(self._content, self.ctx, self._sources),
        }
        self._current: str | None = None
        self._current_kwargs: dict[str, Any] = {}
        self._history: list[tuple[str, dict[str, Any]]] = []
        self._fullscreen = False

        self.bind("<KeyPress>", self._on_key)
        self.bind("<Escape>", lambda _e: self._fullscreen and self.toggle_fullscreen())
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self.navigate("library" if self.ctx.library.all() else "search", reset=True)

    # ------------------------------------------------------------------ Layout

    def _build_sidebar(self) -> None:
        self._sidebar = side = ctk.CTkFrame(self, width=theme.SIDEBAR_WIDTH, fg_color=theme.SURFACE, corner_radius=0)
        side.grid(row=0, column=0, sticky="ns")
        side.grid_propagate(False)

        ctk.CTkLabel(side, text="◆ Anime Gallery", font=theme.font(18, "bold"), text_color=theme.TEXT
                     ).pack(anchor="w", padx=20, pady=(22, 24))
        self._nav_buttons: dict[str, ctk.CTkButton] = {}
        for name, label in NAV_ITEMS:
            button = theme.ghost_button(side, text=label, anchor="w", height=40, corner_radius=10,
                                        command=lambda n=name: self.navigate(n, reset=True))
            button.pack(fill="x", padx=12, pady=3)
            self._nav_buttons[name] = button
        ctk.CTkLabel(side, text="Metadaten: AniList", font=theme.font(11), text_color=theme.TEXT_MUTED
                     ).pack(side="bottom", anchor="w", padx=20, pady=16)

    # ------------------------------------------------------------------ Navigation

    def navigate(self, name: str, reset: bool = False, **kwargs: Any) -> None:
        if self._current is not None:
            self._hide_current()
            if reset:
                self._history.clear()
            else:
                self._history.append((self._current, self._current_kwargs))
        self._show(name, kwargs, resumed=False)

    def back(self) -> None:
        if not self._history:
            return
        self._hide_current()
        name, kwargs = self._history.pop()
        self._show(name, kwargs, resumed=True)

    def _hide_current(self) -> None:
        view = self._views[self._current]
        view.on_hide()
        view.grid_remove()
        if self._current == "player" and self._fullscreen:
            self.toggle_fullscreen()

    def _show(self, name: str, kwargs: dict[str, Any], resumed: bool) -> None:
        self._current, self._current_kwargs = name, kwargs
        view = self._views[name]
        view.grid(row=0, column=0, sticky="nsew")
        view.on_resume() if resumed else view.on_show(**kwargs)
        for nav_name, button in self._nav_buttons.items():
            button.configure(fg_color=theme.SURFACE_HOVER if nav_name == name else "transparent")

    # ------------------------------------------------------------------ Querschnitt

    def notify(self, text: str, level: NotifyLevel = "info") -> None:
        self._status.configure(text=f"   {text}", text_color=NOTIFY_COLORS[level])
        if self._status_clear_id is not None:
            self.after_cancel(self._status_clear_id)
        self._status_clear_id = self.after(6000, lambda: self._status.configure(text=""))

    def toggle_fullscreen(self) -> None:
        self._fullscreen = not self._fullscreen
        self.attributes("-fullscreen", self._fullscreen)
        player: PlayerView = self._views["player"]
        if self._fullscreen:
            self._sidebar.grid_remove()
            self._status.grid_remove()
        else:
            self._sidebar.grid()
            self._status.grid()
        player.set_controls_visible(not self._fullscreen)

    def _on_key(self, event) -> None:
        # Eingabefelder behalten ihre Tasten (Leertaste im Suchfeld!)
        if isinstance(event.widget, (ctk.CTkEntry, ctk.CTkTextbox)) or event.widget.winfo_class() in ("Entry", "Text"):
            return
        if self._current is not None:
            self._views[self._current].handle_key(event)

    def _on_close(self) -> None:
        self._views["player"].shutdown()
        self._runner.shutdown(cleanup=self._http.aclose())
        self.destroy()
