"""Design-Tokens – alle Farben/Maße an einer Stelle."""
from __future__ import annotations

from functools import cache

import customtkinter as ctk

BG = "#0F1117"
SURFACE = "#171A23"
SURFACE_2 = "#1F2330"
SURFACE_HOVER = "#272C3B"
BORDER = "#2A2F3E"
TEXT = "#E8EAF0"
TEXT_MUTED = "#8A90A2"
ACCENT = "#7C5CFF"
ACCENT_HOVER = "#6A4BEB"
SUCCESS = "#3DD68C"
DANGER = "#FF5C7A"

CARD_WIDTH = 168
CARD_GAP = 10
COVER_SIZE = (160, 228)
DETAIL_COVER_SIZE = (200, 286)
SIDEBAR_WIDTH = 210


def apply() -> None:
    ctk.set_appearance_mode("dark")
    ctk.set_default_color_theme("blue")


@cache
def font(size: int = 13, weight: str = "normal") -> ctk.CTkFont:
    """Erst nach Erzeugen des Hauptfensters aufrufen."""
    return ctk.CTkFont(family="Segoe UI", size=size, weight=weight)


def ghost_button(master, **kwargs) -> ctk.CTkButton:
    options = {"fg_color": "transparent", "hover_color": SURFACE_HOVER, "text_color": TEXT, "font": font(13)}
    return ctk.CTkButton(master, **(options | kwargs))


def accent_button(master, **kwargs) -> ctk.CTkButton:
    options = {"fg_color": ACCENT, "hover_color": ACCENT_HOVER, "font": font(13, "bold"), "corner_radius": 8}
    return ctk.CTkButton(master, **(options | kwargs))


def format_time(seconds: float) -> str:
    seconds = int(seconds)
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
