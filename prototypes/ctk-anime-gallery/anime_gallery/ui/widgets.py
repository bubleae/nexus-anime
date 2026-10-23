"""Wiederverwendbare Widgets: Cover-Kachel und responsives Raster."""
from __future__ import annotations

import tkinter as tk
from dataclasses import dataclass
from typing import Any, Callable

import customtkinter as ctk
from PIL import Image

from anime_gallery.ui import theme
from anime_gallery.ui.context import AppContext


@dataclass(slots=True, frozen=True)
class GridItem:
    key: Any
    title: str
    subtitle: str = ""
    cover_url: str | None = None
    badge: str | None = None


def _shorten(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


class CoverCard(ctk.CTkFrame):
    def __init__(self, master, item: GridItem, on_click: Callable[[GridItem], None]) -> None:
        super().__init__(
            master,
            width=theme.CARD_WIDTH,
            fg_color=theme.SURFACE,
            corner_radius=12,
            border_width=2,
            border_color=theme.SURFACE,
        )
        self.item = item
        self._ctk_image: ctk.CTkImage | None = None

        w, h = theme.COVER_SIZE
        self._cover = ctk.CTkLabel(self, text="", width=w, height=h, fg_color=theme.SURFACE_2, corner_radius=10)
        self._cover.pack(padx=4, pady=(4, 6))
        if item.badge:
            ctk.CTkLabel(
                self._cover, text=f" {item.badge} ", fg_color=theme.ACCENT, corner_radius=6,
                text_color="white", font=theme.font(11, "bold"), height=20,
            ).place(x=8, y=8)

        self._title = ctk.CTkLabel(
            self, text=_shorten(item.title, 48), font=theme.font(13, "bold"), text_color=theme.TEXT,
            wraplength=w - 4, justify="left", anchor="w",
        )
        self._title.pack(fill="x", padx=8)
        self._subtitle = ctk.CTkLabel(
            self, text=item.subtitle, font=theme.font(11), text_color=theme.TEXT_MUTED, anchor="w",
        )
        self._subtitle.pack(fill="x", padx=8, pady=(0, 8))

        for widget in (self, self._cover, self._title, self._subtitle):
            widget.bind("<Button-1>", lambda _e: on_click(item))
            widget.bind("<Enter>", lambda _e: self._set_hover(True))
            widget.bind("<Leave>", self._on_leave)
        # Kind-Fenster ohne eigenen Cursor erben den des Elternfensters.
        tk.Frame.configure(self, cursor="hand2")

    def set_image(self, image: Image.Image) -> None:
        self._ctk_image = ctk.CTkImage(light_image=image, dark_image=image, size=theme.COVER_SIZE)
        self._cover.configure(image=self._ctk_image)

    def _set_hover(self, active: bool) -> None:
        self.configure(border_color=theme.ACCENT if active else theme.SURFACE)

    def _on_leave(self, _event) -> None:
        # <Leave> feuert auch beim Wechsel auf ein Kind-Widget – nur wirklich verlassen zählt.
        x, y = self.winfo_pointerxy()
        hovered = self.winfo_containing(x, y)
        if hovered is None or not str(hovered).startswith(str(self)):
            self._set_hover(False)


class CoverGrid(ctk.CTkScrollableFrame):
    """Kachelraster, das die Spaltenzahl an die Fensterbreite anpasst und Cover asynchron nachlädt."""

    def __init__(self, master, ctx: AppContext, on_select: Callable[[GridItem], None], empty_text: str = "Keine Einträge") -> None:
        super().__init__(master, fg_color="transparent")
        self._ctx = ctx
        self._on_select = on_select
        self._cards: list[CoverCard] = []
        self._columns = 1
        self._empty = ctk.CTkLabel(self, text=empty_text, text_color=theme.TEXT_MUTED, font=theme.font(14))
        self._parent_canvas.bind("<Configure>", self._on_resize, add="+")
        self._layout()

    def set_empty_text(self, text: str) -> None:
        self._empty.configure(text=text)

    def set_items(self, items: list[GridItem], append: bool = False) -> None:
        if not append:
            for card in self._cards:
                card.destroy()
            self._cards.clear()
            self._parent_canvas.yview_moveto(0)
        for item in items:
            card = CoverCard(self, item, self._on_select)
            self._cards.append(card)
            self._load_cover(card)
        self._layout()

    def _load_cover(self, card: CoverCard) -> None:
        if not card.item.cover_url:
            return

        def done(image: Image.Image) -> None:
            if card.winfo_exists():
                card.set_image(image)

        self._ctx.runner.submit(
            self._ctx.images.load(card.item.cover_url, theme.COVER_SIZE), on_done=done, on_error=lambda _e: None
        )

    def _on_resize(self, event) -> None:
        scale = ctk.ScalingTracker.get_widget_scaling(self)
        slot = (theme.CARD_WIDTH + 2 * theme.CARD_GAP + 4) * scale
        columns = max(1, int(event.width // slot))
        if columns != self._columns:
            self._columns = columns
            self._layout()

    def _layout(self) -> None:
        if not self._cards:
            self._empty.grid(row=0, column=0, padx=20, pady=60, sticky="w")
            return
        self._empty.grid_forget()
        for index, card in enumerate(self._cards):
            card.grid(row=index // self._columns, column=index % self._columns,
                      padx=theme.CARD_GAP, pady=theme.CARD_GAP, sticky="n")
