"""
Stream-Extractor für NEXUS ANIME (Beispiel-Plugin).

Wird im Dialog „Stream-Link abspielen“ (oder per nexus.player.play_url) eine Webseite statt eines
Video-Links eingegeben, fragt der Player die registrierten Resolver. Dieser hier sucht in der Seite
nach dem eigentlichen HLS-Manifest (.m3u8) oder der Videodatei (.mp4/.mkv/.webm) – siehe extractor.py.

Außerdem gibt es im Player einen Knopf „In mpv/VLC öffnen“ (external_player.py) für Streams, die im
integrierten Player nicht laufen, weil der Server einen Referer verlangt oder CORS sperrt.

Nur für eigene Server und Inhalte, die du nutzen darfst. Kopiergeschützte Streams (DRM) werden abgelehnt.
"""

import nexus
from extractor import NoStreamFound, ProtectedStream, StreamError, extract
from external_player import PlayerNotFound, play


def aufloesen(url):
    """Resolver: gibt eine Stream-Beschreibung zurück oder None, wenn nichts gefunden wurde."""
    try:
        stream = extract(url, depth=int(nexus.config.get("depth") or 2))
    except NoStreamFound as e:
        print(f"Kein Stream in {url}: {e} (geprüft: {len(e.tried)} Links)")
        return None
    except ProtectedStream:
        raise  # Meldung erscheint im Player
    except StreamError as e:
        print(f"Fehler bei {url}: {e}")
        return None
    print(f"Gefunden: {stream.kind} {stream.url}")
    return stream.to_spec()


def extern_abspielen(ctx):
    stream = ctx.get("stream")
    if not stream:
        url, headers, subs = ctx.episode.file_path, {}, []
    else:
        url, headers = stream.url, dict(stream.get("headers") or {})
        if stream.get("page") and "Referer" not in headers:
            headers["Referer"] = stream.page
        subs = [s.url for s in stream.get("subtitles") or []]
    nexus.player.pause()
    try:
        name = play(url, title=ctx.episode.title, headers=headers, subtitles=subs, start=ctx.get("time"))
    except PlayerNotFound as e:
        nexus.ui.toast("error", "Kein externer Player", str(e))
        return
    nexus.ui.toast("success", f"Läuft in {name}")


nexus.player.add_resolver(id="html-extractor", name="Stream-Extractor", resolve=aufloesen)
nexus.ui.add_player_button(label="In mpv/VLC öffnen", icon="📺", on_click=extern_abspielen)
