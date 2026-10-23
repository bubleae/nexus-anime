"""Eingebetteter Player: Videofläche (natives Fenster-Handle) + eigene Steuerleiste."""
from __future__ import annotations

import tkinter as tk
from typing import Callable

import customtkinter as ctk

from anime_gallery.core.models import Series
from anime_gallery.player.backends import PlayerBackend, PlayerUnavailable, create_backend
from anime_gallery.services.sources import PlaybackItem
from anime_gallery.ui import theme
from anime_gallery.ui.context import AppContext, View


class PlayerView(ctk.CTkFrame, View):
    POLL_MS = 500
    WATCHED_THRESHOLD = 0.9
    SEEK_STEP = 10

    def __init__(self, master, ctx: AppContext) -> None:
        super().__init__(master, fg_color="black", corner_radius=0)
        self._ctx = ctx
        self._backend: PlayerBackend | None = None
        self._poll_id: str | None = None
        self._dragging = False
        self._series: Series | None = None
        self._season_index = 0
        self._episode_index = 0
        self._persist: Callable[[], None] = lambda: None

        # Reines tk.Frame: mpv/VLC zeichnen über winfo_id() direkt hinein.
        self._video = tk.Frame(self, bg="black", highlightthickness=0)
        self._video.pack(fill="both", expand=True)
        self._message = ctk.CTkLabel(self._video, text="", text_color=theme.TEXT_MUTED, font=theme.font(15),
                                     fg_color="black", justify="center")

        self._controls = bar = ctk.CTkFrame(self, fg_color=theme.SURFACE, corner_radius=0, height=64)
        bar.pack(fill="x")
        bar.grid_columnconfigure(5, weight=1)

        theme.ghost_button(bar, text="←", width=40, command=ctx.back).grid(row=0, column=0, padx=(12, 4), pady=12)
        theme.ghost_button(bar, text="⏮", width=40, command=lambda: self._step(-1)).grid(row=0, column=1, padx=2)
        self._play_button = theme.accent_button(bar, text="⏸", width=48, command=self._toggle_pause)
        self._play_button.grid(row=0, column=2, padx=2)
        theme.ghost_button(bar, text="⏭", width=40, command=lambda: self._step(1)).grid(row=0, column=3, padx=2)

        self._title = ctk.CTkLabel(bar, text="", font=theme.font(13, "bold"), text_color=theme.TEXT, anchor="w", width=260)
        self._title.grid(row=0, column=4, padx=(12, 8), sticky="w")

        self._seek = ctk.CTkSlider(bar, from_=0, to=1, number_of_steps=1000, command=self._on_seek_drag,
                                   progress_color=theme.ACCENT, button_color=theme.ACCENT,
                                   button_hover_color=theme.ACCENT_HOVER)
        self._seek.set(0)
        self._seek.grid(row=0, column=5, sticky="ew", padx=8)
        self._seek.bind("<ButtonPress-1>", lambda _e: setattr(self, "_dragging", True))
        self._seek.bind("<ButtonRelease-1>", self._on_seek_release)

        self._time = ctk.CTkLabel(bar, text="00:00 / 00:00", font=theme.font(12), text_color=theme.TEXT_MUTED, width=110)
        self._time.grid(row=0, column=6, padx=4)
        ctk.CTkLabel(bar, text="🔊", font=theme.font(14)).grid(row=0, column=7, padx=(8, 0))
        self._volume = ctk.CTkSlider(bar, from_=0, to=100, width=110, command=self._on_volume,
                                     progress_color=theme.TEXT_MUTED, button_color=theme.TEXT)
        self._volume.set(80)
        self._volume.grid(row=0, column=8, padx=4)
        theme.ghost_button(bar, text="⛶", width=40, command=ctx.toggle_fullscreen).grid(row=0, column=9, padx=(4, 12))

    # ------------------------------------------------------------------ Lebenszyklus

    def on_show(self, series: Series, season_index: int, episode_index: int,
                persist: Callable[[], None] | None = None, **_kwargs) -> None:
        self._series = series
        self._season_index = season_index
        self._episode_index = episode_index
        self._persist = persist or (lambda: None)
        self._start_current()

    def on_hide(self) -> None:
        self._stop_polling()
        if self._backend is not None:
            self._backend.stop()

    def shutdown(self) -> None:
        self._stop_polling()
        if self._backend is not None:
            self._backend.shutdown()
            self._backend = None

    def handle_key(self, event) -> bool:
        if self._backend is None:
            return False
        key = event.keysym
        if key == "space":
            self._toggle_pause()
        elif key == "Left":
            self._backend.seek(self._backend.position - self.SEEK_STEP)
        elif key == "Right":
            self._backend.seek(self._backend.position + self.SEEK_STEP)
        elif key in ("f", "F"):
            self._ctx.toggle_fullscreen()
        else:
            return False
        return True

    def set_controls_visible(self, visible: bool) -> None:
        if visible:
            self._controls.pack(fill="x")
        else:
            self._controls.pack_forget()

    # ------------------------------------------------------------------ Wiedergabe

    def _show_message(self, text: str) -> None:
        self._message.configure(text=text)
        self._message.place(relx=0.5, rely=0.5, anchor="center")

    def _ensure_backend(self) -> bool:
        if self._backend is not None:
            return True
        self.update_idletasks()  # Fenster-Handle muss existieren, bevor mpv/VLC andocken
        try:
            backend = create_backend()
            backend.attach(self._video)
            backend.set_volume(int(self._volume.get()))
        except PlayerUnavailable as exc:
            self._show_message(f"{exc}\n\nInstalliere libmpv (mpv-2.dll) oder VLC – siehe README.")
            return False
        self._backend = backend
        return True

    def _start_current(self) -> None:
        assert self._series is not None
        season = self._series.seasons[self._season_index]
        episode = season.episodes[self._episode_index]
        self._title.configure(text=f"{self._series.title} · {episode.label}"[:60])
        self._seek.set(0)
        self._show_message("Quelle wird gesucht …")
        self._ctx.runner.submit(self._ctx.resolvers.resolve(self._series, season, episode),
                                on_done=self._play_item, on_error=self._ctx.error)

    def _play_item(self, item: PlaybackItem | None) -> None:
        if item is None:
            self._show_message("Für diese Folge ist keine Quelle hinterlegt.\n"
                               "Verknüpfe einen lokalen Ordner oder hinterlege eine Stream-URL.")
            return
        if not self._ensure_backend():
            return
        assert self._backend is not None
        self._message.place_forget()
        self._backend.play(item.url)
        self._ctx.info(f"Spiele {item.title} ({item.source}, {self._backend.name})")
        self._start_polling()

    def _toggle_pause(self) -> None:
        if self._backend is not None:
            self._backend.toggle_pause()

    def _step(self, delta: int) -> None:
        if self._series is None:
            return
        episodes = self._series.seasons[self._season_index].episodes
        target = self._episode_index + delta
        if 0 <= target < len(episodes):
            self._episode_index = target
            self._start_current()
        else:
            self._ctx.info("Keine weitere Folge in dieser Staffel")

    # ------------------------------------------------------------------ Seekbar / Polling

    def _on_seek_drag(self, _value: float) -> None:
        self._dragging = True

    def _on_seek_release(self, _event) -> None:
        self._dragging = False
        if self._backend is not None and self._backend.duration > 0:
            self._backend.seek(self._seek.get() * self._backend.duration)

    def _on_volume(self, value: float) -> None:
        if self._backend is not None:
            self._backend.set_volume(int(value))

    def _start_polling(self) -> None:
        self._stop_polling()
        self._poll()

    def _stop_polling(self) -> None:
        if self._poll_id is not None:
            self.after_cancel(self._poll_id)
            self._poll_id = None

    def _poll(self) -> None:
        backend = self._backend
        if backend is not None:
            position, duration = backend.position, backend.duration
            if duration > 0 and not self._dragging:
                self._seek.set(position / duration)
            self._time.configure(text=f"{theme.format_time(position)} / {theme.format_time(duration)}")
            self._play_button.configure(text="▶" if backend.paused else "⏸")
            self._mark_watched(position, duration)
        self._poll_id = self.after(self.POLL_MS, self._poll)

    def _mark_watched(self, position: float, duration: float) -> None:
        if self._series is None or duration <= 0 or position / duration < self.WATCHED_THRESHOLD:
            return
        episode = self._series.seasons[self._season_index].episodes[self._episode_index]
        if not episode.watched:
            episode.watched = True
            self._persist()
