"""Mediathek: alle gespeicherten Serien als Kachelraster mit Filter."""
from __future__ import annotations

import customtkinter as ctk

from anime_gallery.core.models import Series
from anime_gallery.ui import theme
from anime_gallery.ui.context import AppContext, View
from anime_gallery.ui.widgets import CoverGrid, GridItem


def _subtitle(series: Series) -> str:
    seasons = len(series.seasons)
    parts = [f"{seasons} Staffel" + ("n" if seasons != 1 else ""), f"{series.episode_count} Folgen"]
    if series.watched_count:
        parts.append(f"{series.watched_count} gesehen")
    return " · ".join(parts)


class LibraryView(ctk.CTkFrame, View):
    def __init__(self, master, ctx: AppContext) -> None:
        super().__init__(master, fg_color="transparent")
        self._ctx = ctx
        self._visible = False

        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=24, pady=(20, 8))
        ctk.CTkLabel(header, text="Bibliothek", font=theme.font(26, "bold"), text_color=theme.TEXT).pack(side="left")
        self._count = ctk.CTkLabel(header, text="", font=theme.font(12), text_color=theme.TEXT_MUTED)
        self._count.pack(side="left", padx=12, pady=(8, 0))

        self._filter = ctk.CTkEntry(header, placeholder_text="Filtern …", width=240, height=34,
                                    fg_color=theme.SURFACE, border_color=theme.BORDER, corner_radius=10)
        self._filter.pack(side="right")
        self._filter.bind("<KeyRelease>", lambda _e: self._refresh())

        self._grid = CoverGrid(
            self, ctx, on_select=lambda item: ctx.navigate("detail", series_id=item.key),
            empty_text="Noch leer – über „Suche“ Serien hinzufügen.",
        )
        self._grid.pack(fill="both", expand=True, padx=14, pady=(0, 8))

        ctx.library.subscribe(lambda: self._visible and self._refresh())

    def on_show(self, **_kwargs) -> None:
        self._visible = True
        self._refresh()

    def on_resume(self) -> None:
        self.on_show()

    def on_hide(self) -> None:
        self._visible = False

    def _refresh(self) -> None:
        needle = self._filter.get().strip().casefold()
        all_series = self._ctx.library.all()
        shown = [s for s in all_series if needle in s.title.casefold()]
        self._count.configure(text=f"{len(shown)} von {len(all_series)}" if needle else f"{len(all_series)} Serien")
        self._grid.set_items([
            GridItem(s.id, s.title, _subtitle(s), s.cover_url, badge="Lokal" if s.has_local_files else None)
            for s in shown
        ])
