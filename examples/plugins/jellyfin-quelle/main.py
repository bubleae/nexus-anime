"""
Jellyfin-Suchquelle für NEXUS ANIME (Beispiel-Plugin).

Sucht Serien und Filme auf deinem eigenen Jellyfin-Server und zeigt sie unter „Entdecken“.
Ein Klick auf eine Folge spielt sie im integrierten Player (über nexus.player.play_url).

Einrichtung: Einstellungen → Plugins → Jellyfin → Server-Adresse und API-Schlüssel eintragen.
Den API-Schlüssel erstellst du in Jellyfin unter Dashboard → API-Schlüssel.
"""

import json
import urllib.parse
import urllib.request

import nexus


def _server() -> str:
    return (nexus.config.get("server") or "").rstrip("/")


def _key() -> str:
    key = nexus.config.get("apiKey") or ""
    if not key:
        raise RuntimeError("Bitte unter Einstellungen → Plugins → Jellyfin einen API-Schlüssel eintragen.")
    return key


def _get(path: str, **params):
    params["api_key"] = _key()
    url = f"{_server()}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def _image(item_id: str, kind: str, tag: str | None):
    if not tag:
        return None
    return f"{_server()}/Items/{item_id}/Images/{kind}?tag={tag}&quality=90&api_key={_key()}"


def _stream(item_id: str) -> str:
    key = _key()
    if nexus.config.get("transcode") is False:
        return f"{_server()}/Videos/{item_id}/stream?static=true&api_key={key}"
    # HLS mit H.264/AAC – spielt im Player zuverlässig
    q = urllib.parse.urlencode({
        "api_key": key, "MediaSourceId": item_id, "VideoCodec": "h264", "AudioCodec": "aac",
        "TranscodingMaxAudioChannels": 2, "SegmentContainer": "ts",
    })
    return f"{_server()}/Videos/{item_id}/master.m3u8?{q}"


def _subtitles(item: dict):
    subs = []
    for src in item.get("MediaSources") or []:
        for s in src.get("MediaStreams") or []:
            if s.get("Type") == "Subtitle" and s.get("IsTextSubtitleStream"):
                subs.append({
                    "url": f"{_server()}/Videos/{item['Id']}/{src['Id']}/Subtitles/{s['Index']}/Stream.vtt?api_key={_key()}",
                    "label": s.get("DisplayTitle") or s.get("Language") or "Untertitel",
                    "lang": s.get("Language"),
                })
    return subs


def _as_result(it: dict) -> dict:
    tags = it.get("ImageTags") or {}
    backdrops = it.get("BackdropImageTags") or []
    return {
        "id": it["Id"],
        "type": it.get("Type"),
        "title": it.get("Name"),
        "subtitle": it.get("OriginalTitle") if it.get("OriginalTitle") != it.get("Name") else None,
        "year": it.get("ProductionYear"),
        "description": it.get("Overview"),
        "genres": it.get("Genres") or [],
        "cover_url": _image(it["Id"], "Primary", tags.get("Primary")),
        "banner_url": _image(it["Id"], "Backdrop", backdrops[0] if backdrops else None),
    }


def suchen(query):
    data = _get(
        "/Items", searchTerm=query, IncludeItemTypes="Series,Movie", Recursive="true",
        Fields="Overview,Genres,ProductionYear,OriginalTitle", Limit=40,
    )
    return [_as_result(it) for it in data.get("Items", [])]


def details(item):
    if item.type == "Movie":
        movie = _get(f"/Items/{item.id}", Fields="MediaSources")
        return {**item, "episodes": [{"number": 1, "title": item.title, "stream_url": _stream(item.id), "subtitles": _subtitles(movie)}]}
    data = _get(f"/Shows/{item.id}/Episodes", Fields="Overview,MediaSources", EnableImages="true")
    episodes = []
    for ep in data.get("Items", []):
        tags = ep.get("ImageTags") or {}
        episodes.append({
            "season": ep.get("ParentIndexNumber"),
            "number": ep.get("IndexNumber"),
            "title": ep.get("Name"),
            "description": ep.get("Overview"),
            "duration": (ep.get("RunTimeTicks") or 0) / 10_000_000 or None,
            "thumbnail": _image(ep["Id"], "Primary", tags.get("Primary")),
            "stream_url": _stream(ep["Id"]),
            "subtitles": _subtitles(ep),
        })
    return {**item, "episodes": episodes}


nexus.discover.add_source(id="jellyfin", name="Jellyfin", icon="🟣", search=suchen, details=details)
