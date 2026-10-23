"""Quellen: eigene Stream-Links mit Platzhaltern anlegen, sortieren, (de)aktivieren."""
from __future__ import annotations

import customtkinter as ctk

from anime_gallery.services.sources import PLACEHOLDERS, SourceConfig, SourceStore, preview_template
from anime_gallery.ui import theme
from anime_gallery.ui.context import AppContext, View


class SourcesView(ctk.CTkFrame, View):
    def __init__(self, master, ctx: AppContext, store: SourceStore) -> None:
        super().__init__(master, fg_color="transparent")
        self._ctx = ctx
        self._store = store

        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=24, pady=(20, 4))
        ctk.CTkLabel(header, text="Quellen", font=theme.font(26, "bold"), text_color=theme.TEXT).pack(side="left")
        ctk.CTkLabel(
            self, anchor="w", justify="left", font=theme.font(12), text_color=theme.TEXT_MUTED,
            text="Eigene Stream-Links mit Platzhaltern. Beim Abspielen werden die Quellen von oben nach unten "
                 "probiert –\nlokale Dateien und pro Folge hinterlegte URLs haben immer Vorrang.",
        ).pack(fill="x", padx=24, pady=(0, 12))

        # ---- Formular
        form = ctk.CTkFrame(self, fg_color=theme.SURFACE, corner_radius=16)
        form.pack(fill="x", padx=24)
        form.grid_columnconfigure(1, weight=1)

        self._name = ctk.CTkEntry(form, placeholder_text="Name (optional)", width=200, height=38,
                                  fg_color=theme.SURFACE_2, border_color=theme.BORDER)
        self._name.grid(row=0, column=0, padx=(16, 8), pady=(16, 6))
        self._link = ctk.CTkEntry(form, height=38, fg_color=theme.SURFACE_2, border_color=theme.BORDER,
                                  placeholder_text="https://mein-server/anime/{slug}/S{season}E{episode:02d}.m3u8")
        self._link.grid(row=0, column=1, sticky="ew", pady=(16, 6))
        self._link.bind("<KeyRelease>", lambda _e: self._update_preview())
        self._link.bind("<Return>", lambda _e: self._add())
        theme.accent_button(form, text="＋  Hinzufügen", width=130, height=38, command=self._add
                            ).grid(row=0, column=2, padx=16, pady=(16, 6))

        self._preview = ctk.CTkLabel(form, text="", anchor="w", font=theme.font(12), text_color=theme.TEXT_MUTED)
        self._preview.grid(row=1, column=0, columnspan=3, sticky="ew", padx=16)
        help_text = "Platzhalter:   " + "    ".join(f"{k} {v}" for k, v in PLACEHOLDERS.items())
        ctk.CTkLabel(form, text=help_text, anchor="w", justify="left", wraplength=900, font=theme.font(11),
                     text_color=theme.TEXT_MUTED).grid(row=2, column=0, columnspan=3, sticky="ew", padx=16, pady=(4, 14))

        # ---- Liste
        self._list = ctk.CTkScrollableFrame(self, fg_color=theme.SURFACE, corner_radius=16)
        self._list.pack(fill="both", expand=True, padx=24, pady=16)

        store.subscribe(self._render)
        self._update_preview()
        self._render()

    def on_show(self, **_kwargs) -> None:
        self._link.focus_set()

    def _update_preview(self) -> None:
        template = self._link.get().strip()
        if not template:
            self._preview.configure(text="Beispiel-Vorschau erscheint beim Tippen.", text_color=theme.TEXT_MUTED)
            return
        try:
            self._preview.configure(text=f"Frieren, Staffel 1, Folge 3  →  {preview_template(template)}",
                                    text_color=theme.TEXT_MUTED)
        except ValueError as exc:
            self._preview.configure(text=str(exc), text_color=theme.DANGER)

    def _add(self) -> None:
        try:
            source = self._store.add(self._name.get(), self._link.get())
        except ValueError as exc:
            self._ctx.error(exc)
            return
        self._name.delete(0, "end")
        self._link.delete(0, "end")
        self._update_preview()
        self._ctx.success(f"Quelle „{source.name}“ hinzugefügt")

    def _render(self) -> None:
        for child in self._list.winfo_children():
            child.destroy()
        sources = self._store.items
        if not sources:
            ctk.CTkLabel(self._list, text="Noch keine eigenen Quellen.", text_color=theme.TEXT_MUTED,
                         font=theme.font(13)).pack(pady=30)
            return
        for index, source in enumerate(sources):
            self._row(index, source, last=index == len(sources) - 1)

    def _row(self, index: int, source: SourceConfig, last: bool) -> None:
        row = ctk.CTkFrame(self._list, fg_color=theme.SURFACE_2, corner_radius=10)
        row.pack(fill="x", padx=6, pady=3)
        row.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(row, text=f"{index + 1}.", width=28, font=theme.font(13, "bold"),
                     text_color=theme.TEXT_MUTED).grid(row=0, column=0, rowspan=2, padx=(10, 4))
        ctk.CTkLabel(row, text=source.name, anchor="w", font=theme.font(13, "bold"),
                     text_color=theme.TEXT if source.enabled else theme.TEXT_MUTED
                     ).grid(row=0, column=1, sticky="ew", pady=(8, 0))
        ctk.CTkLabel(row, text=source.template, anchor="w", font=theme.font(11), text_color=theme.TEXT_MUTED
                     ).grid(row=1, column=1, sticky="ew", pady=(0, 8))

        switch = ctk.CTkSwitch(row, text="Aktiv", progress_color=theme.ACCENT, font=theme.font(12),
                               command=lambda: self._store.set_enabled(source.id, bool(switch.get())))
        switch.select() if source.enabled else switch.deselect()
        switch.grid(row=0, column=2, rowspan=2, padx=8)
        theme.ghost_button(row, text="↑", width=34, state="disabled" if index == 0 else "normal",
                           command=lambda: self._store.move(source.id, -1)).grid(row=0, column=3, rowspan=2)
        theme.ghost_button(row, text="↓", width=34, state="disabled" if last else "normal",
                           command=lambda: self._store.move(source.id, 1)).grid(row=0, column=4, rowspan=2)
        theme.ghost_button(row, text="Entfernen", width=90, text_color=theme.DANGER,
                           command=lambda: self._store.remove(source.id)).grid(row=0, column=5, rowspan=2, padx=(4, 10))
