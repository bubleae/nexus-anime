"""
HLS- und Video-Streams in einem lokalen Player abspielen – mpv (bevorzugt) oder VLC.

Das ist nützlich, wenn ein Stream im integrierten Player nicht läuft, weil der Server einen Referer
oder eigene Header verlangt oder keine Zugriffe von anderen Programmen erlaubt (CORS): mpv und VLC
dürfen beliebige Header setzen und kennen kein CORS.

    from external_player import play
    play("https://example.org/hls/master.m3u8", title="Folge 3", headers={"Referer": "https://example.org/"})

Reihenfolge: mpv (PATH oder übliche Installationsorte) → python-vlc (`pip install python-vlc`) → vlc.exe.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading

__all__ = ["play", "find_mpv", "find_vlc", "PlayerNotFound"]


class PlayerNotFound(RuntimeError):
    pass


def _first_existing(paths: list[str]) -> str | None:
    return next((p for p in paths if p and os.path.isfile(p)), None)


def find_mpv() -> str | None:
    local = os.environ.get("LOCALAPPDATA", "")
    return shutil.which("mpv") or _first_existing([
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "mpv", "mpv.exe"),
        os.path.join(local, "Programs", "mpv", "mpv.exe"),
        os.path.join(os.path.expanduser("~"), "scoop", "apps", "mpv", "current", "mpv.exe"),
        r"C:\ProgramData\chocolatey\bin\mpv.exe",
    ])


def find_vlc() -> str | None:
    return shutil.which("vlc") or _first_existing([
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "VideoLAN", "VLC", "vlc.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "VideoLAN", "VLC", "vlc.exe"),
    ])


def _mpv_args(url: str, title: str | None, headers: dict[str, str], subtitles: list[str], start: float | None) -> list[str]:
    args = ["--force-window=immediate", "--keep-open=yes"]
    if title:
        args.append(f"--force-media-title={title}")
    ua = headers.get("User-Agent")
    if ua:
        args.append(f"--user-agent={ua}")
    if headers.get("Referer"):
        args.append(f"--referrer={headers['Referer']}")
    other = [f"{k}: {v}" for k, v in headers.items() if k not in ("User-Agent", "Referer")]
    if other:
        # mpv trennt die Liste an Kommas – Kommas im Wert müssen maskiert werden
        args.append("--http-header-fields=" + ",".join(h.replace(",", r"\,") for h in other))
    for s in subtitles:
        args.append(f"--sub-file={s}")
    if start:
        args.append(f"--start={start:.0f}")
    # HLS: beste Qualität wählen, Puffer für wacklige Verbindungen
    args += ["--hls-bitrate=max", "--cache=yes", "--demuxer-max-bytes=150MiB", url]
    return args


def _play_python_vlc(url: str, title: str | None, headers: dict[str, str], subtitles: list[str], start: float | None) -> bool:
    try:
        import vlc  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 – nicht installiert oder libvlc fehlt
        return False
    opts = []
    if headers.get("Referer"):
        opts.append(f":http-referrer={headers['Referer']}")
    if headers.get("User-Agent"):
        opts.append(f":http-user-agent={headers['User-Agent']}")
    if start:
        opts.append(f":start-time={start:.0f}")
    instance = vlc.Instance("--no-video-title-show")
    media = instance.media_new(url, *opts)
    if title:
        media.set_meta(vlc.Meta.Title, title)
    mp = instance.media_player_new()
    mp.set_media(media)
    for s in subtitles:
        mp.add_slave(vlc.MediaSlaveType.subtitle, s, True)
    mp.play()

    # Am Leben halten, bis die Wiedergabe endet oder das Fenster geschlossen wird
    def wait() -> None:
        import time

        while mp.get_state() not in (vlc.State.Ended, vlc.State.Error, vlc.State.Stopped):
            time.sleep(1)
        mp.release()

    threading.Thread(target=wait, daemon=True).start()
    return True


def play(url: str, *, title: str | None = None, headers: dict[str, str] | None = None,
         subtitles: list[str] | None = None, start: float | None = None) -> str:
    """Startet die Wiedergabe und kehrt sofort zurück. Gibt den Namen des Players zurück."""
    headers = headers or {}
    subtitles = subtitles or []
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

    mpv = find_mpv()
    if mpv:
        subprocess.Popen([mpv, *_mpv_args(url, title, headers, subtitles, start)], creationflags=flags)
        return "mpv"
    if _play_python_vlc(url, title, headers, subtitles, start):
        return "VLC"
    vlc_exe = find_vlc()
    if vlc_exe:
        args = [vlc_exe, url]
        if headers.get("Referer"):
            args.append(f":http-referrer={headers['Referer']}")
        if headers.get("User-Agent"):
            args.append(f":http-user-agent={headers['User-Agent']}")
        if title:
            args.append(f":meta-title={title}")
        args += [f"--sub-file={s}" for s in subtitles[:1]]
        subprocess.Popen(args, creationflags=flags)
        return "VLC"
    raise PlayerNotFound("Weder mpv noch VLC gefunden. Installiere mpv (mpv.io) oder VLC (videolan.org).")
