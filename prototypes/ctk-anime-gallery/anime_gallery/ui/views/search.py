"""Suche: Debounced Live-Suche gegen den MetadataProvider, Ergebnisse als Kachelraster."""
from __future__ import annotations

from concurrent.futures import Future

import customtkinter as ctk

from anime_gallery.core.models import AnimeSummary, SearchPage
from anime_gallery.ui import theme
from anime_gallery.ui.context import AppContext, View
from anime_gallery.ui.widgets import CoverGrid, GridItem

FORMAT_LABELS = {"TV": "TV", "TV_SHORT": "TV kurz", "MOVIE": "Film", "SPECIAL": "Special",
                 "OVA": "OVA", "ONA": "ONA", "MUSIC": "Musik"}


def _subtitle(anime: AnimeSummary) -> str:
    parts = [FORMAT_LABELS.get(anime.format or "", anime.format or ""), str(anime.year or "")]
    if anime.episodes:
        parts.append(f"{anime.episodes} Folgen")
    if anime.score:
        parts.append(f"★ {anime.score / 10:.1f}")
    return " · ".join(p for p in parts if p)


class SearchView(ctk.CTkFrame, View):
    DEBOUNCE_MS = 400

    def __init__(self, master, ctx: AppContext) -> None:
        super().__init__(master, fg_color="transparent")
        self._ctx = ctx
        self._debounce_id: str | None = None
        self._generation = 0  # verwirft Antworten veralteter Anfragen
        self._future: Future | None = None
        self._query = ""
        self._page = 1

        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=24, pady=(20, 8))
        ctk.CTkLabel(header, text="Suche", font=theme.font(26, "bold"), text_color=theme.TEXT).pack(side="left")
        self._status = ctk.CTkLabel(header, text="", font=theme.font(12), text_color=theme.TEXT_MUTED)
        self._status.pack(side="right")

        self._entry = ctk.CTkEntry(
            self, placeholder_text="Anime suchen … (z. B. Frieren, Steins;Gate)", height=44,
            font=theme.font(15), corner_radius=12, border_color=theme.BORDER, fg_color=theme.SURFACE,
        )
        self._entry.pack(fill="x", padx=24, pady=(0, 8))
        self._entry.bind("<KeyRelease>", self._on_key)
        self._entry.bind("<Return>", lambda _e: self._search(force=True))

        self._grid = CoverGrid(
            self, ctx, on_select=lambda item: ctx.navigate("detail", anilist_id=item.key),
            empty_text="Gib einen Titel ein, um AniList zu durchsuchen.",
        )
        self._grid.pack(fill="both", expand=True, padx=14)

        self._more = theme.accent_button(self, text="Mehr laden", command=lambda: self._search(page=self._page + 1))

    def on_show(self, **_kwargs) -> None:
        self._entry.focus_set()

    def on_resume(self) -> None:
        self._entry.focus_set()

    def _on_key(self, event) -> None:
        if event.keysym == "Return":
            return
        if self._debounce_id is not None:
            self.after_cancel(self._debounce_id)
        self._debounce_id = self.after(self.DEBOUNCE_MS, self._search)

    def _search(self, page: int = 1, force: bool = False) -> None:
        self._debounce_id = None
        query = self._entry.get().strip()
        if len(query) < 2 or (page == 1 and query == self._query and not force):
            return
        if self._future is not None:
            self._future.cancel()
        self._query, self._page = query, page
        self._generation += 1
        generation = self._generation
        self._status.configure(text="Suche …", text_color=theme.TEXT_MUTED)
        self._future = self._ctx.runner.submit(
            self._ctx.metadata.search(query, page),
            on_done=lambda result: self._show(result, generation),
            on_error=lambda exc: self._fail(exc, generation),
        )

    def _show(self, result: SearchPage, generation: int) -> None:
        if generation != self._generation:
            return
        library = self._ctx.library
        items = [
            GridItem(a.anilist_id, a.title, _subtitle(a), a.cover_url,
                     badge="In Bibliothek" if library.find_by_anilist(a.anilist_id) else None)
            for a in result.items
        ]
        if result.page == 1 and not items:
            self._grid.set_empty_text(f"Keine Treffer für „{self._query}“.")
        self._grid.set_items(items, append=result.page > 1)
        self._status.configure(text=f"Seite {result.page}" + (" · weitere verfügbar" if result.has_next else ""))
        if result.has_next:
            self._more.pack(pady=10)
        else:
            self._more.pack_forget()

    def _fail(self, exc: BaseException, generation: int) -> None:
        if generation == self._generation:
            self._status.configure(text="Fehler", text_color=theme.DANGER)
            self._ctx.error(exc)
