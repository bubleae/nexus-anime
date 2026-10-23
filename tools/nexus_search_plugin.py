"""
nexus_search_plugin.py – Suche und Episodenlisten für das Nexus-Anime-UI.

Quelle ist die offizielle, öffentliche AniList-GraphQL-API (https://anilist.co).
Es werden nur Metadaten abgefragt (Titel, Cover, Beschreibung, Episoden) – keine
Videos, keine Downloads. Kein Scraping nötig, daher auch keine HTML-Selektoren.

Benötigt:  pip install requests

Nutzung:
    from nexus_search_plugin import search_for_ui, get_episodes_for_ui
    karten = search_for_ui("Call of the Night")
    folgen = get_episodes_for_ui(karten[0]["detail_url"])

Oder als Kommandozeile (gibt JSON aus, praktisch zum Testen oder für Aufrufe aus anderen Programmen):
    python nexus_search_plugin.py search "Call of the Night"
    python nexus_search_plugin.py episodes https://anilist.co/anime/141391
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
from typing import Any

import requests

API_URL = "https://graphql.anilist.co"
USER_AGENT = "NexusAnime-SearchPlugin/1.0"
# AniList erlaubt 90 Anfragen/Minute (zeitweise 30) – wir bleiben deutlich darunter.
MIN_INTERVAL_SECONDS = 2.1
TIMEOUT_SECONDS = 20

_last_request = 0.0

SEARCH_QUERY = """
query ($search: String, $perPage: Int) {
  Page(perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
      id
      siteUrl
      title { romaji english native }
      description(asHtml: false)
      coverImage { extraLarge large }
    }
  }
}
"""

EPISODES_QUERY = """
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    episodes
    nextAiringEpisode { episode }
    streamingEpisodes { title thumbnail url site }
  }
}
"""


class NexusSearchError(Exception):
    """Verständliche Fehlermeldung für das UI."""


def _post(query: str, variables: dict[str, Any]) -> dict[str, Any]:
    """Sendet eine GraphQL-Anfrage mit Drosselung und Wiederholung bei Ratenlimit."""
    global _last_request
    for attempt in range(3):
        wait = MIN_INTERVAL_SECONDS - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()
        try:
            resp = requests.post(
                API_URL,
                json={"query": query, "variables": variables},
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            raise NexusSearchError(f"AniList nicht erreichbar – besteht eine Internetverbindung? ({exc})") from exc
        if resp.status_code == 429 and attempt < 2:
            time.sleep(min(int(resp.headers.get("Retry-After", "30")), 90))
            continue
        if resp.status_code != 200:
            raise NexusSearchError(f"AniList antwortete mit Status {resp.status_code}")
        data = resp.json()
        if data.get("errors"):
            raise NexusSearchError(data["errors"][0].get("message", "Unbekannter Fehler"))
        return data["data"]
    raise NexusSearchError("Zu viele Anfragen – bitte kurz warten.")


def _clean_description(text: str | None, max_len: int = 300) -> str:
    """Entfernt HTML-Reste und kürzt auf eine Kurzbeschreibung."""
    if not text:
        return ""
    text = re.sub(r"<br\s*/?>", " ", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_len:
        text = text[: max_len].rsplit(" ", 1)[0] + " …"
    return text


def _anilist_id(detail_url: str) -> int:
    match = re.search(r"anilist\.co/anime/(\d+)", detail_url) or re.fullmatch(r"anime-(\d+)", detail_url.strip())
    if not match:
        raise NexusSearchError("Unbekannte Detail-URL – erwartet wird ein AniList-Link wie https://anilist.co/anime/123")
    return int(match.group(1))


def search_for_ui(query: str, limit: int = 20) -> list[dict[str, str]]:
    """Sucht Anime und liefert Kacheln für das UI-Grid."""
    query = (query or "").strip()
    if not query:
        return []
    data = _post(SEARCH_QUERY, {"search": query, "perPage": max(1, min(limit, 50))})
    results = []
    for media in data["Page"]["media"]:
        titles = media["title"]
        results.append(
            {
                "id": f"anime-{media['id']}",
                "title": titles.get("english") or titles.get("romaji") or titles.get("native") or "",
                "cover_url": media["coverImage"].get("extraLarge") or media["coverImage"].get("large") or "",
                "description": _clean_description(media.get("description")),
                "detail_url": media.get("siteUrl") or f"https://anilist.co/anime/{media['id']}",
            }
        )
    return results


def get_episodes_for_ui(detail_url: str) -> list[dict[str, Any]]:
    """Liefert die Episodenliste einer Serie für die Detailansicht.

    Wenn AniList offizielle Episodendaten kennt (z. B. von Crunchyroll), werden deren Titel
    verwendet; sonst wird die Liste anhand der Episodenanzahl erzeugt. Zusätzlich zu den
    geforderten Feldern enthält jede Folge optional "thumbnail_url" und "watch_url"
    (offizieller Anbieter) – das UI kann diese ignorieren oder als Link anbieten.
    """
    anime_id = _anilist_id(detail_url)
    media = _post(EPISODES_QUERY, {"id": anime_id})["Media"]
    if media is None:
        raise NexusSearchError("Serie nicht gefunden")

    official: dict[int, dict[str, str]] = {}
    for ep in media.get("streamingEpisodes") or []:
        # Titel haben meist die Form "Episode 3 - Titel"
        m = re.match(r"\s*(?:Episode|Ep\.?|Folge)\s*(\d+)\s*[-–:]?\s*(.*)", ep.get("title") or "", re.I)
        if m:
            official.setdefault(int(m.group(1)), {"title": m.group(2).strip(), "thumbnail_url": ep.get("thumbnail") or "", "watch_url": ep.get("url") or ""})

    total = media.get("episodes")
    if not total and media.get("nextAiringEpisode"):
        total = media["nextAiringEpisode"]["episode"] - 1  # laufende Serie: bisher erschienene Folgen
    if not total:
        total = max(official) if official else 0

    episodes = []
    for n in range(1, total + 1):
        info = official.get(n, {})
        episodes.append(
            {
                "episode_number": n,
                "title": info.get("title") or f"Episode {n}",
                "episode_id": f"anime-{anime_id}-ep-{n}",
                "thumbnail_url": info.get("thumbnail_url", ""),
                "watch_url": info.get("watch_url", ""),
            }
        )
    return episodes


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 3 or sys.argv[1] not in ("search", "episodes"):
        print(__doc__)
        sys.exit(1)
    try:
        out = search_for_ui(sys.argv[2]) if sys.argv[1] == "search" else get_episodes_for_ui(sys.argv[2])
        print(json.dumps(out, ensure_ascii=False, indent=2))
    except NexusSearchError as err:
        print(json.dumps({"error": str(err)}, ensure_ascii=False))
        sys.exit(2)
