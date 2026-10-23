"""Detailansicht: Metadaten, Staffel-Umschalter, Episodenliste, Ordner-/URL-Verknüpfung."""
from __future__ import annotations

import math
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk
from PIL import Image

from anime_gallery.core.models import AnimeDetails, Episode, Relation, Season, Series
from anime_gallery.services.library import scan_folder
from anime_gallery.ui import theme
from anime_gallery.ui.context import AppContext, View
from anime_gallery.ui.views.search import FORMAT_LABELS

RELATION_LABELS = {"SEQUEL": "Fortsetzung", "PREQUEL": "Vorgänger", "SIDE_STORY": "Nebengeschichte",
                   "SPIN_OFF": "Spin-off", "ALTERNATIVE": "Alternative", "PARENT": "Hauptserie"}
RELATIONS_PLACEHOLDER = "＋ Staffel / Verwandtes hinzufügen"


def _short(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


class DetailView(ctk.CTkFrame, View):
    EPISODES_PER_PAGE = 100

    def __init__(self, master, ctx: AppContext) -> None:
        super().__init__(master, fg_color="transparent")
        self._ctx = ctx
        self._series: Series | None = None
        self._in_library = False
        self._season_index = 0
        self._episode_page = 0
        self._generation = 0
        self._season_labels: list[str] = []
        self._relations: dict[str, Relation] = {}
        self._cover_image: ctk.CTkImage | None = None

        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x", padx=24, pady=(16, 0))
        theme.ghost_button(top, text="← Zurück", width=90, command=ctx.back).pack(side="left")

        # ---- Kopfbereich
        hero = ctk.CTkFrame(self, fg_color=theme.SURFACE, corner_radius=16)
        hero.pack(fill="x", padx=24, pady=12)
        hero.grid_columnconfigure(1, weight=1)
        w, h = theme.DETAIL_COVER_SIZE
        self._cover = ctk.CTkLabel(hero, text="", width=w, height=h, fg_color=theme.SURFACE_2, corner_radius=12)
        self._cover.grid(row=0, column=0, rowspan=5, padx=16, pady=16, sticky="n")

        self._title = ctk.CTkLabel(hero, text="", font=theme.font(24, "bold"), text_color=theme.TEXT,
                                   anchor="w", justify="left", wraplength=760)
        self._title.grid(row=0, column=1, sticky="ew", padx=(0, 16), pady=(16, 2))
        self._meta = ctk.CTkLabel(hero, text="", font=theme.font(13), text_color=theme.TEXT_MUTED, anchor="w")
        self._meta.grid(row=1, column=1, sticky="ew", padx=(0, 16))
        self._genres = ctk.CTkLabel(hero, text="", font=theme.font(12, "bold"), text_color=theme.ACCENT, anchor="w")
        self._genres.grid(row=2, column=1, sticky="ew", padx=(0, 16), pady=(2, 6))
        self._description = ctk.CTkTextbox(hero, height=130, wrap="word", fg_color="transparent",
                                           font=theme.font(13), text_color=theme.TEXT)
        self._description.grid(row=3, column=1, sticky="nsew", padx=(0, 16))

        actions = ctk.CTkFrame(hero, fg_color="transparent")
        actions.grid(row=4, column=1, sticky="w", pady=(8, 16))
        self._library_button = theme.accent_button(actions, text="", width=200, command=self._toggle_library)
        self._library_button.pack(side="left", padx=(0, 8))
        theme.ghost_button(actions, text="📁  Ordner verknüpfen …", border_width=1, border_color=theme.BORDER,
                           command=self._link_folder).pack(side="left")

        # ---- Staffeln
        season_bar = ctk.CTkFrame(self, fg_color="transparent")
        season_bar.pack(fill="x", padx=24, pady=(4, 0))
        ctk.CTkLabel(season_bar, text="Staffeln", font=theme.font(16, "bold"), text_color=theme.TEXT).pack(side="left")
        self._season_switch = ctk.CTkSegmentedButton(
            season_bar, values=["–"], command=self._on_season_selected, font=theme.font(12),
            selected_color=theme.ACCENT, selected_hover_color=theme.ACCENT_HOVER,
        )
        self._season_switch.pack(side="left", padx=12)
        self._relations_menu = ctk.CTkOptionMenu(
            season_bar, values=[RELATIONS_PLACEHOLDER], width=300, command=self._on_relation_selected,
            fg_color=theme.SURFACE_2, button_color=theme.SURFACE_HOVER, button_hover_color=theme.ACCENT,
            dynamic_resizing=False,
        )
        self._relations_menu.pack(side="right")

        # ---- Episoden
        episode_bar = ctk.CTkFrame(self, fg_color="transparent")
        episode_bar.pack(fill="x", padx=24, pady=(12, 0))
        ctk.CTkLabel(episode_bar, text="Episoden", font=theme.font(16, "bold"), text_color=theme.TEXT).pack(side="left")
        self._page_switch = ctk.CTkSegmentedButton(episode_bar, values=["–"], command=self._on_page_selected,
                                                   font=theme.font(11))
        self._episode_list = ctk.CTkScrollableFrame(self, fg_color=theme.SURFACE, corner_radius=16)
        self._episode_list.pack(fill="both", expand=True, padx=24, pady=(8, 16))

    # ------------------------------------------------------------------ Lebenszyklus

    def on_show(self, anilist_id: int | None = None, series_id: str | None = None, **_kwargs) -> None:
        self._generation += 1
        generation = self._generation
        library = self._ctx.library

        if series_id is not None and (series := library.get(series_id)):
            self._set_series(series, in_library=True)
            return
        if anilist_id is None:
            return
        if existing := library.find_by_anilist(anilist_id):
            index = next(i for i, s in enumerate(existing.seasons) if s.anilist_id == anilist_id)
            self._set_series(existing, in_library=True, season_index=index)
            return

        self._show_loading()
        self._ctx.runner.submit(
            self._ctx.metadata.details(anilist_id),
            on_done=lambda d: generation == self._generation and self._set_series(d.to_series(), in_library=False),
            on_error=lambda exc: generation == self._generation and self._ctx.error(exc),
        )

    def on_resume(self) -> None:
        if self._series is not None:  # z. B. nach dem Player: „gesehen“-Status aktualisieren
            self._render_season(reload_relations=False)

    # ------------------------------------------------------------------ Rendering

    def _show_loading(self) -> None:
        self._series = None
        self._title.configure(text="Lade …")
        for label in (self._meta, self._genres):
            label.configure(text="")
        self._set_description("")
        self._cover.configure(image=None)
        self._clear_episodes()

    def _set_series(self, series: Series, in_library: bool, season_index: int = 0) -> None:
        self._series = series
        self._in_library = in_library
        self._season_index = min(season_index, len(series.seasons) - 1)
        self._title.configure(text=series.title)
        self._genres.configure(text="  ·  ".join(series.genres[:6]))
        self._set_description(series.description or "Keine Beschreibung vorhanden.")
        self._update_library_button()
        self._render_season_switch()
        self._render_season()
        self._load_cover(series.cover_url)

    def _set_description(self, text: str) -> None:
        self._description.configure(state="normal")
        self._description.delete("1.0", "end")
        self._description.insert("1.0", text)
        self._description.configure(state="disabled")

    def _load_cover(self, url: str | None) -> None:
        self._cover.configure(image=None)
        if not url:
            return
        generation = self._generation

        def done(image: Image.Image) -> None:
            if generation == self._generation:
                self._cover_image = ctk.CTkImage(image, image, size=theme.DETAIL_COVER_SIZE)
                self._cover.configure(image=self._cover_image)

        self._ctx.runner.submit(self._ctx.images.load(url, theme.DETAIL_COVER_SIZE),
                                on_done=done, on_error=lambda _e: None)

    def _update_library_button(self) -> None:
        if self._in_library:
            self._library_button.configure(text="✓  In der Bibliothek", fg_color=theme.SURFACE_2,
                                           hover_color=theme.DANGER)
        else:
            self._library_button.configure(text="＋  Zur Bibliothek", fg_color=theme.ACCENT,
                                           hover_color=theme.ACCENT_HOVER)

    @property
    def _season(self) -> Season:
        assert self._series is not None
        return self._series.seasons[self._season_index]

    def _render_season_switch(self) -> None:
        assert self._series is not None
        self._season_labels = [f"{i + 1} · {_short(s.title, 26)}" for i, s in enumerate(self._series.seasons)]
        self._season_switch.configure(values=self._season_labels)
        self._season_switch.set(self._season_labels[self._season_index])

    def _render_season(self, reload_relations: bool = True) -> None:
        season = self._season
        local = sum(1 for e in season.episodes if e.local_path)
        watched = sum(1 for e in season.episodes if e.watched)
        parts = [FORMAT_LABELS.get(season.format or "", season.format or ""), str(season.year or ""),
                 f"{len(season.episodes)} Folgen", f"{local} lokal" if local else "", f"{watched} gesehen" if watched else ""]
        self._meta.configure(text="  ·  ".join(p for p in parts if p))
        self._render_episodes()
        if reload_relations:
            self._load_relations(season.anilist_id)

    def _clear_episodes(self) -> None:
        for child in self._episode_list.winfo_children():
            child.destroy()

    def _render_episodes(self) -> None:
        self._clear_episodes()
        episodes = self._season.episodes
        pages = max(1, math.ceil(len(episodes) / self.EPISODES_PER_PAGE))
        self._episode_page = min(self._episode_page, pages - 1)
        if pages > 1:
            n = self.EPISODES_PER_PAGE
            labels = [f"{p * n + 1}–{min((p + 1) * n, len(episodes))}" for p in range(pages)]
            self._page_switch.configure(values=labels)
            self._page_switch.set(labels[self._episode_page])
            self._page_switch.pack(side="right")
        else:
            self._page_switch.pack_forget()

        if not episodes:
            ctk.CTkLabel(self._episode_list, text="Keine Episodenliste verfügbar – verknüpfe einen lokalen Ordner.",
                         text_color=theme.TEXT_MUTED, font=theme.font(13)).pack(pady=30)
            return

        start = self._episode_page * self.EPISODES_PER_PAGE
        for index in range(start, min(start + self.EPISODES_PER_PAGE, len(episodes))):
            self._episode_row(index, episodes[index])
        self._episode_list._parent_canvas.yview_moveto(0)

    def _episode_row(self, index: int, episode: Episode) -> None:
        row = ctk.CTkFrame(self._episode_list, fg_color=theme.SURFACE_2 if index % 2 == 0 else "transparent",
                           corner_radius=8)
        row.pack(fill="x", padx=6, pady=2)
        row.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(row, text=f"{episode.number:>3}", width=44, font=theme.font(13, "bold"),
                     text_color=theme.TEXT_MUTED).grid(row=0, column=0, padx=(8, 4), pady=6)
        title = ctk.CTkLabel(row, text=episode.title or f"Folge {episode.number}", anchor="w", font=theme.font(13),
                             text_color=theme.TEXT_MUTED if episode.watched else theme.TEXT)
        title.grid(row=0, column=1, sticky="ew")

        source = "Lokal" if episode.local_path else "Stream" if episode.stream_url else ""
        if source:
            ctk.CTkLabel(row, text=f" {source} ", fg_color=theme.SURFACE_HOVER, corner_radius=6,
                         font=theme.font(11), text_color=theme.TEXT).grid(row=0, column=2, padx=4)
        if episode.watched:
            ctk.CTkLabel(row, text="✓", text_color=theme.SUCCESS, font=theme.font(14, "bold"), width=20
                         ).grid(row=0, column=3, padx=4)
        theme.ghost_button(row, text="URL", width=48, border_width=1, border_color=theme.BORDER,
                           command=lambda: self._set_stream_url(episode)).grid(row=0, column=4, padx=4)
        theme.accent_button(row, text="▶", width=40, command=lambda: self._play(index),
                            fg_color=theme.ACCENT if episode.has_source else theme.SURFACE_HOVER
                            ).grid(row=0, column=5, padx=(4, 8))

        for widget in (row, title):
            widget.bind("<Double-Button-1>", lambda _e: self._play(index))

    # ------------------------------------------------------------------ Staffeln & Verwandte

    def _on_season_selected(self, label: str) -> None:
        if label in self._season_labels:
            self._season_index = self._season_labels.index(label)
            self._episode_page = 0
            self._render_season()

    def _on_page_selected(self, label: str) -> None:
        values = self._page_switch.cget("values")
        self._episode_page = values.index(label)
        self._render_episodes()

    def _load_relations(self, anilist_id: int) -> None:
        generation = self._generation
        self._relations_menu.configure(values=["Lade verwandte Titel …"], state="disabled")
        self._relations_menu.set("Lade verwandte Titel …")
        self._ctx.runner.submit(
            self._ctx.metadata.details(anilist_id),
            on_done=lambda d: generation == self._generation and self._show_relations(d),
            on_error=lambda _e: self._show_relations(None),
        )

    def _show_relations(self, details: AnimeDetails | None) -> None:
        self._relations.clear()
        if details is not None and self._series is not None:
            known = {s.anilist_id for s in self._series.seasons}
            for rel in details.relations:
                if rel.anime.anilist_id in known:
                    continue
                label = f"{RELATION_LABELS.get(rel.relation_type, rel.relation_type)}: {_short(rel.anime.title, 40)}"
                if rel.anime.year:
                    label += f" ({rel.anime.year})"
                self._relations[label] = rel
        values = list(self._relations) or ["Keine weiteren Titel"]
        self._relations_menu.configure(values=values, state="normal" if self._relations else "disabled")
        self._relations_menu.set(RELATIONS_PLACEHOLDER)

    def _on_relation_selected(self, label: str) -> None:
        self._relations_menu.set(RELATIONS_PLACEHOLDER)
        relation = self._relations.get(label)
        if relation is None:
            return
        generation = self._generation
        self._ctx.info(f"Lade „{relation.anime.title}“ …")
        self._ctx.runner.submit(
            self._ctx.metadata.details(relation.anime.anilist_id),
            on_done=lambda d: generation == self._generation and self._add_season(d, relation.relation_type),
            on_error=self._ctx.error,
        )

    def _add_season(self, details: AnimeDetails, relation_type: str) -> None:
        assert self._series is not None
        position = self._season_index if relation_type == "PREQUEL" else self._season_index + 1
        self._series.seasons.insert(position, details.to_season())
        self._season_index = position
        self._episode_page = 0
        self._persist()
        self._render_season_switch()
        self._render_season()
        self._ctx.success(f"„{details.title}“ als Staffel hinzugefügt")

    # ------------------------------------------------------------------ Aktionen

    def _persist(self) -> None:
        if self._in_library and self._series is not None:
            self._ctx.library.upsert(self._series)

    def _toggle_library(self) -> None:
        series = self._series
        if series is None:
            return
        if self._in_library:
            if not messagebox.askyesno("Aus Bibliothek entfernen",
                                       f"„{series.title}“ aus der Bibliothek entfernen?\n"
                                       "Lokale Dateien bleiben unangetastet.", parent=self):
                return
            self._ctx.library.remove(series.id)
            self._in_library = False
            self._ctx.info(f"„{series.title}“ entfernt")
        else:
            self._ctx.library.upsert(series)
            self._in_library = True
            self._ctx.success(f"„{series.title}“ zur Bibliothek hinzugefügt")
        self._update_library_button()

    def _link_folder(self) -> None:
        if self._series is None:
            return
        folder = filedialog.askdirectory(title="Ordner mit Episoden wählen", mustexist=True, parent=self)
        if not folder:
            return
        season = self._season
        self._ctx.info("Durchsuche Ordner …")
        self._ctx.runner.run_blocking(
            scan_folder, Path(folder),
            on_done=lambda mapping: self._apply_folder(season, folder, mapping),
            on_error=lambda exc: self._ctx.error(f"Ordner konnte nicht gelesen werden: {exc}"),
        )

    def _apply_folder(self, season: Season, folder: str, mapping: dict[int, str]) -> None:
        season.folder = folder
        by_number = {e.number: e for e in season.episodes}
        for episode in season.episodes:
            episode.local_path = mapping.get(episode.number)
        for number, path in mapping.items():
            if number not in by_number:
                season.episodes.append(Episode(number=number, local_path=path))
        season.episodes.sort(key=lambda e: e.number)
        self._persist()
        if self._series is not None and season is self._season:
            self._render_season(reload_relations=False)
        if mapping:
            self._ctx.success(f"{len(mapping)} Dateien zugeordnet")
        else:
            self._ctx.error("Keine Videodateien mit erkennbarer Folgennummer gefunden")

    def _set_stream_url(self, episode: Episode) -> None:
        dialog = ctk.CTkInputDialog(title="Stream-URL",
                                    text=f"HLS-/Video-URL für {episode.label}\n(z. B. https://…/master.m3u8, leer = entfernen)")
        url = dialog.get_input()
        if url is None:
            return
        url = url.strip()
        if url and not url.startswith(("http://", "https://")):
            self._ctx.error("Nur http(s)-URLs werden unterstützt")
            return
        episode.stream_url = url or None
        self._persist()
        self._render_season(reload_relations=False)

    def _play(self, index: int) -> None:
        if self._series is None:
            return
        self._ctx.navigate("player", series=self._series, season_index=self._season_index,
                           episode_index=index, persist=self._persist)
