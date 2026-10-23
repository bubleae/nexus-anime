"""Eingebettete Video-Player.

Beide Backends rendern direkt in das native Fenster-Handle eines ``tk.Frame``
(``winfo_id()``) – das Video läuft also *in* der App, nicht in einem eigenen
Fenster. mpv wird bevorzugt (bessere HLS-/Untertitel-Unterstützung, OSC),
VLC dient als Fallback.
"""
from __future__ import annotations

import logging
import os
import sys
import tkinter as tk
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

BIN_DIR = Path(__file__).resolve().parents[2] / "bin"


class PlayerUnavailable(RuntimeError):
    pass


class PlayerBackend(ABC):
    name: str

    @abstractmethod
    def attach(self, widget: tk.Misc) -> None: ...

    @abstractmethod
    def play(self, url: str) -> None: ...

    @abstractmethod
    def toggle_pause(self) -> None: ...

    @abstractmethod
    def seek(self, seconds: float) -> None: ...

    @abstractmethod
    def set_volume(self, volume: int) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...

    @abstractmethod
    def shutdown(self) -> None: ...

    @property
    @abstractmethod
    def position(self) -> float: ...

    @property
    @abstractmethod
    def duration(self) -> float: ...

    @property
    @abstractmethod
    def paused(self) -> bool: ...


def _mpv_log(level: str, component: str, message: str) -> None:
    log.debug("mpv[%s] %s: %s", level, component, message.strip())


class MpvBackend(PlayerBackend):
    name = "mpv"

    def __init__(self) -> None:
        if BIN_DIR.is_dir():  # libmpv-2.dll darf einfach in <Projekt>/bin liegen
            os.environ["PATH"] = str(BIN_DIR) + os.pathsep + os.environ.get("PATH", "")
        try:
            import mpv  # python-mpv, lädt libmpv beim Import
        except (ImportError, OSError) as exc:
            raise PlayerUnavailable(f"libmpv nicht verfügbar: {exc}") from exc
        self._mpv_module: Any = mpv
        self._player: Any = None

    def attach(self, widget: tk.Misc) -> None:
        self._player = self._mpv_module.MPV(
            wid=str(widget.winfo_id()),
            osc=True,  # mpv-eigene Bedienleiste im Video
            input_default_bindings=True,
            input_vo_keyboard=True,
            keep_open="yes",
            hwdec="auto-safe",
            ytdl=False,
            log_handler=_mpv_log,
            loglevel="warn",
        )

    def play(self, url: str) -> None:
        self._player.pause = False
        self._player.play(url)

    def toggle_pause(self) -> None:
        self._player.pause = not self._player.pause

    def seek(self, seconds: float) -> None:
        try:
            self._player.seek(max(0.0, seconds), reference="absolute")
        except Exception:  # noch nichts geladen
            log.debug("Seek ignoriert", exc_info=True)

    def set_volume(self, volume: int) -> None:
        self._player.volume = volume

    def stop(self) -> None:
        if self._player is not None:
            self._player.command("stop")

    def shutdown(self) -> None:
        if self._player is not None:
            self._player.terminate()
            self._player = None

    @property
    def position(self) -> float:
        return float(self._player.time_pos or 0.0) if self._player else 0.0

    @property
    def duration(self) -> float:
        return float(self._player.duration or 0.0) if self._player else 0.0

    @property
    def paused(self) -> bool:
        return bool(self._player.pause) if self._player else True


class VlcBackend(PlayerBackend):
    name = "VLC"

    def __init__(self) -> None:
        try:
            import vlc
        except Exception as exc:  # python-vlc wirft je nach Fehlerbild unterschiedliche Typen
            raise PlayerUnavailable(f"libVLC nicht verfügbar: {exc}") from exc
        self._instance = vlc.Instance("--quiet", "--no-video-title-show")
        if self._instance is None:
            raise PlayerUnavailable("libVLC konnte nicht initialisiert werden")
        self._player = self._instance.media_player_new()

    def attach(self, widget: tk.Misc) -> None:
        handle = widget.winfo_id()
        if sys.platform.startswith("win"):
            self._player.set_hwnd(handle)
        elif sys.platform == "darwin":
            self._player.set_nsobject(handle)
        else:
            self._player.set_xwindow(handle)

    def play(self, url: str) -> None:
        self._player.set_media(self._instance.media_new(url))
        self._player.play()

    def toggle_pause(self) -> None:
        self._player.pause()

    def seek(self, seconds: float) -> None:
        self._player.set_time(int(max(0.0, seconds) * 1000))

    def set_volume(self, volume: int) -> None:
        self._player.audio_set_volume(int(volume))

    def stop(self) -> None:
        self._player.stop()

    def shutdown(self) -> None:
        self._player.stop()
        self._player.release()
        self._instance.release()

    @property
    def position(self) -> float:
        return max(0, self._player.get_time()) / 1000

    @property
    def duration(self) -> float:
        return max(0, self._player.get_length()) / 1000

    @property
    def paused(self) -> bool:
        return not self._player.is_playing()


def create_backend(preferred: tuple[type[PlayerBackend], ...] = (MpvBackend, VlcBackend)) -> PlayerBackend:
    errors: list[str] = []
    for backend_cls in preferred:
        try:
            backend = backend_cls()
            log.info("Player-Backend: %s", backend.name)
            return backend
        except PlayerUnavailable as exc:
            errors.append(str(exc))
    raise PlayerUnavailable("Kein Player-Backend gefunden.\n" + "\n".join(errors))
