"""
Stream-Extractor: findet zu einem Link die eigentliche Videoquelle (HLS-Manifest .m3u8 oder Videodatei).

Nur Standardbibliothek – das Modul funktioniert auch ohne NEXUS ANIME:

    from extractor import extract
    s = extract("http://192.168.1.10:8080/serie/folge-3.html")
    print(s.kind, s.url)          # "hls" http://192.168.1.10:8080/hls/folge-3/master.m3u8

Ablauf:
1. Der Link wird kurz angefragt (nur die ersten Bytes). Inhaltstyp und Dateianfang zeigen, ob es schon
   ein Video ist („#EXTM3U“, MP4-„ftyp“, Matroska/WebM-Kennung …) oder eine HTML-Seite.
2. Bei einer Seite werden Kandidaten gesammelt: <video>/<source>-Tags, og:video-Angaben, JSON-LD
   (VideoObject.contentUrl), Player-Konfigurationen im Skript-Code (auch mit maskierten „\\/“) und
   eingebettete <iframe>-Player (bis zu `depth` Ebenen tief).
3. Die Kandidaten werden nach Wahrscheinlichkeit sortiert und der Reihe nach geprüft; der erste,
   der wirklich ein Video liefert, gewinnt.

Kopiergeschützte Streams (Widevine/PlayReady/FairPlay, SAMPLE-AES) werden erkannt und abgelehnt –
die kann kein Player ohne Lizenzserver abspielen. Normale AES-128-Verschlüsselung von HLS ist kein
Kopierschutz und wird unterstützt.
"""

from __future__ import annotations

import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser

__all__ = ["Stream", "Probe", "StreamError", "NoStreamFound", "ProtectedStream", "probe", "extract", "find_candidates"]

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MAX_PAGE_BYTES = 3 * 1024 * 1024
MAX_CANDIDATES = 12
MAX_IFRAMES = 6

_VIDEO_EXT = re.compile(r"\.(mp4|m4v|mkv|webm|mov)(?:$|[?#])", re.I)
_HLS_EXT = re.compile(r"\.m3u8(?:$|[?#])|[?&](?:format|container)=m3u8", re.I)
_DASH_EXT = re.compile(r"\.mpd(?:$|[?#])", re.I)
_SUB_EXT = re.compile(r"\.(vtt|srt)(?:$|[?#])", re.I)
# Absolute oder protokoll-relative Links auf Medien irgendwo im Seitentext (Skripte, JSON, Attribute)
_MEDIA_IN_TEXT = re.compile(r"""(?:https?:)?//[^\s"'<>()\\]+?\.(?:m3u8|mp4|m4v|webm|mkv|mov)(?:\?[^\s"'<>()\\]*)?(?=["'\s<>)\\]|$)""", re.I)
# Werte von Schlüsseln wie file:, src:, source:, hls:, url: in Player-Konfigurationen (auch relative Pfade)
_MEDIA_IN_CONFIG = re.compile(r"""["']?(?:file|src|source|hls|hlsUrl|videoUrl|stream|url)["']?\s*[:=]\s*["']([^"']+?\.(?:m3u8|mp4|m4v|webm|mkv)(?:\?[^"']*)?)["']""", re.I)
_DRM = re.compile(r"METHOD=SAMPLE-AES|KEYFORMAT=\"(?:urn:uuid:edef8ba9|com\.microsoft\.playready|com\.apple\.streamingkeydelivery)", re.I)
_AD_HINT = re.compile(r"(?:^|[/_.-])(?:ads?|preroll|vast|banner|promo|trailer)(?:[/_.-]|$)", re.I)


class StreamError(Exception):
    """Basisklasse aller Fehler des Extractors."""


class NoStreamFound(StreamError):
    """Kein abspielbarer Link gefunden. `is_page` = der Link war eine Webseite."""

    def __init__(self, message: str, *, is_page: bool = False, tried: list[str] | None = None) -> None:
        super().__init__(message)
        self.is_page = is_page
        self.tried = tried or []


class ProtectedStream(StreamError):
    """Der Stream ist per DRM geschützt und kann nicht abgespielt werden."""


@dataclass
class Probe:
    url: str  # nach Weiterleitungen
    status: int
    content_type: str
    head: bytes  # die ersten Bytes der Antwort

    @property
    def kind(self) -> str:
        """"hls", "file", "dash", "html" oder "unknown"."""
        ct = self.content_type
        start = self.head.lstrip(b"\xef\xbb\xbf \t\r\n")
        if start.startswith(b"#EXTM3U") or "mpegurl" in ct:
            return "hls"
        if "dash+xml" in ct or b"<MPD" in start[:400]:
            return "dash"
        if _is_video_bytes(start) or ct.startswith(("video/", "audio/")):
            return "file"
        if "html" in ct or start[:15].lower().startswith((b"<!doctype html", b"<html")) or b"<head" in start[:500].lower():
            return "html"
        # Manche Server liefern Videos als application/octet-stream – dann zählt die Endung
        if ct in ("", "application/octet-stream", "binary/octet-stream"):
            if _HLS_EXT.search(self.url):
                return "hls"
            if _VIDEO_EXT.search(self.url):
                return "file"
        return "unknown"


@dataclass
class Stream:
    url: str
    kind: str  # "hls" oder "file"
    page: str | None = None  # Webseite, auf der der Link gefunden wurde
    title: str | None = None
    headers: dict[str, str] = field(default_factory=dict)  # für externe Player (Referer, User-Agent)
    subtitles: list[dict] = field(default_factory=list)  # [{"url", "label", "lang"}]

    def to_spec(self) -> dict:
        """Als Stream-Beschreibung für `nexus.player.play_url` bzw. einen Resolver."""
        spec = {"url": self.url, "type": self.kind, "headers": self.headers}
        if self.page:
            spec["page"] = self.page
        if self.title:
            spec["title"] = self.title
        if self.subtitles:
            spec["subtitles"] = self.subtitles
        return spec


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _is_video_bytes(b: bytes) -> bool:
    return (
        b[4:8] == b"ftyp"  # MP4/MOV/M4V
        or b.startswith(b"\x1a\x45\xdf\xa3")  # Matroska/WebM
        or (len(b) > 188 and b[0] == 0x47 and b[188] == 0x47)  # MPEG-TS
    )


def _request(url: str, headers: dict[str, str] | None, extra: dict[str, str] | None = None) -> urllib.request.Request:
    h = {"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Language": "de,en;q=0.8"}
    h.update(headers or {})
    h.update(extra or {})
    return urllib.request.Request(url, headers=h)


def probe(url: str, headers: dict[str, str] | None = None, timeout: float = 12) -> Probe:
    """Fragt nur den Anfang an (Range), lädt also keine ganzen Videos herunter."""
    req = _request(url, headers, {"Range": "bytes=0-4095"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Probe(r.geturl(), r.status, (r.headers.get_content_type() or "").lower(), r.read(4096))
    except urllib.error.HTTPError as e:
        if e.code == 416:  # Range nicht erfüllbar → ohne Range nochmal
            with urllib.request.urlopen(_request(url, headers), timeout=timeout) as r:
                return Probe(r.geturl(), r.status, (r.headers.get_content_type() or "").lower(), r.read(4096))
        raise StreamError(f"Der Server antwortet mit HTTP {e.code} ({e.reason}).") from e
    except urllib.error.URLError as e:
        raise StreamError(f"Der Server ist nicht erreichbar: {e.reason}") from e
    except TimeoutError as e:
        raise StreamError("Zeitüberschreitung – der Server antwortet nicht.") from e


def _fetch_text(url: str, headers: dict[str, str] | None, timeout: float) -> tuple[str, str]:
    """Lädt eine Seite (höchstens 3 MB). Gibt (Text, endgültige URL) zurück."""
    try:
        with urllib.request.urlopen(_request(url, headers, {"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}), timeout=timeout) as r:
            raw = r.read(MAX_PAGE_BYTES)
            charset = r.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, errors="replace"), r.geturl()
    except (urllib.error.URLError, TimeoutError) as e:
        raise StreamError(f"Die Seite konnte nicht geladen werden: {getattr(e, 'reason', e)}") from e


# ---------------------------------------------------------------------------
# HTML auswerten
# ---------------------------------------------------------------------------

class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.media: list[tuple[str, int]] = []  # (Link, Grundpunktzahl)
        self.iframes: list[str] = []
        self.tracks: list[dict] = []
        self.ld_json: list[str] = []
        self.title = ""
        self.og_title = ""
        self._in: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag in ("video", "audio", "source"):
            for key in ("src", "data-src"):
                if a.get(key):
                    # <source type="application/x-mpegURL"> ist ein sicherer Hinweis
                    bonus = 30 if "mpegurl" in a.get("type", "").lower() else 0
                    self.media.append((a[key], 80 + bonus))
        elif tag == "track" and a.get("src") and a.get("kind", "subtitles") in ("subtitles", "captions"):
            self.tracks.append({"url": a["src"], "label": a.get("label") or None, "lang": a.get("srclang") or None})
        elif tag == "iframe":
            src = a.get("src") or a.get("data-src")
            if src and not src.startswith(("about:", "javascript:", "data:")):
                self.iframes.append(src)
        elif tag == "meta":
            prop = (a.get("property") or a.get("name") or "").lower()
            content = a.get("content", "")
            if prop in ("og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream") and content:
                self.media.append((content, 70))
            elif prop == "og:title" and content:
                self.og_title = content
        elif tag == "link" and a.get("rel", "").lower() in ("video_src", "preload") and a.get("href"):
            if _HLS_EXT.search(a["href"]) or _VIDEO_EXT.search(a["href"]):
                self.media.append((a["href"], 60))
        elif tag == "script" and "ld+json" in a.get("type", "").lower():
            self._in, self._buf = "ld", []
        elif tag == "title":
            self._in, self._buf = "title", []

    def handle_data(self, data: str) -> None:
        if self._in:
            self._buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._in == "ld" and tag == "script":
            self.ld_json.append("".join(self._buf))
            self._in = None
        elif self._in == "title" and tag == "title":
            self.title = "".join(self._buf).strip()
            self._in = None


def _ld_urls(text: str) -> list[str]:
    """contentUrl/embedUrl aus JSON-LD (VideoObject)."""
    try:
        data = json.loads(text)
    except ValueError:
        return []
    found: list[str] = []

    def walk(o: object) -> None:
        if isinstance(o, dict):
            for k in ("contentUrl", "embedUrl"):
                if isinstance(o.get(k), str):
                    found.append(o[k])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    return found


def _unescape_js(text: str) -> str:
    """Macht maskierte Links in Skripten lesbar: https:\\/\\/… und \\u002F."""
    return text.replace("\\/", "/").replace("\\u002F", "/").replace("\\u002f", "/").replace("\\u0026", "&").replace("&amp;", "&")


def _score(url: str, base: int) -> int:
    s = base
    if _HLS_EXT.search(url):
        s += 25 + (10 if re.search(r"master|playlist|index", url, re.I) else 0)
    m = re.search(r"(2160|1440|1080|720|480|360)p?", url)
    if m:
        s += int(m.group(1)) // 120  # höhere Auflösung zuerst
    if _AD_HINT.search(urllib.parse.urlsplit(url).path):
        s -= 60
    return s


def find_candidates(page: str, base_url: str) -> tuple[list[str], list[str], list[dict], str]:
    """Wertet eine HTML-Seite aus. Gibt (Medien-Links sortiert, iframes, Untertitel, Titel) zurück."""
    p = _PageParser()
    try:
        p.feed(page)
        p.close()
    except Exception:  # noqa: BLE001 – kaputtes HTML: was bis dahin gefunden wurde, zählt
        pass
    scored: dict[str, int] = {}

    def add(raw: str, base: int) -> None:
        raw = html.unescape(_unescape_js(raw.strip()))
        if not raw or raw.startswith(("blob:", "data:", "javascript:")):
            return
        url = urllib.parse.urljoin(base_url, raw)
        if not url.startswith(("http://", "https://")) or _DASH_EXT.search(url):
            return
        scored[url] = max(scored.get(url, -999), _score(url, base))

    for url, base in p.media:
        add(url, base)
    for block in p.ld_json:
        for url in _ld_urls(block):
            if _HLS_EXT.search(url) or _VIDEO_EXT.search(url):
                add(url, 65)
            else:
                p.iframes.append(url)  # embedUrl zeigt meist auf eine Player-Seite
    text = _unescape_js(page)
    for m in _MEDIA_IN_CONFIG.finditer(text):
        add(m.group(1), 50)
    for m in _MEDIA_IN_TEXT.finditer(text):
        add(m.group(0), 40)

    media = sorted(scored, key=lambda u: -scored[u])[:MAX_CANDIDATES]
    iframes = list(dict.fromkeys(urllib.parse.urljoin(base_url, html.unescape(f)) for f in p.iframes))
    iframes = [f for f in iframes if f.startswith(("http://", "https://")) and f != base_url][:MAX_IFRAMES]
    subs = []
    for t in p.tracks:
        url = urllib.parse.urljoin(base_url, t["url"])
        if _SUB_EXT.search(url):
            subs.append({**t, "url": url})
    return media, iframes, subs, (p.og_title or p.title)


# ---------------------------------------------------------------------------
# Auflösen
# ---------------------------------------------------------------------------

def _check_hls(url: str, headers: dict[str, str], timeout: float) -> None:
    """Lehnt DRM-geschützte HLS-Streams ab (prüft Master und die erste Variante)."""
    text, final = _fetch_text(url, headers, timeout)
    if _DRM.search(text):
        raise ProtectedStream("Dieser Stream ist kopiergeschützt (DRM) und kann nicht abgespielt werden.")
    if "#EXT-X-STREAM-INF" in text:
        variant = next((ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")), None)
        if variant:
            sub, _ = _fetch_text(urllib.parse.urljoin(final, variant), headers, timeout)
            if _DRM.search(sub):
                raise ProtectedStream("Dieser Stream ist kopiergeschützt (DRM) und kann nicht abgespielt werden.")


def _as_stream(pr: Probe, headers: dict[str, str], page: str | None, timeout: float) -> Stream | None:
    kind = pr.kind
    if kind == "hls":
        _check_hls(pr.url, headers, timeout)
        return Stream(pr.url, "hls", page=page, headers=headers)
    if kind == "file":
        return Stream(pr.url, "file", page=page, headers=headers)
    if kind == "dash":
        raise NoStreamFound("Das ist ein DASH-Stream (.mpd) – der Player unterstützt nur HLS (.m3u8) und Videodateien.")
    return None


def extract(url: str, *, headers: dict[str, str] | None = None, depth: int = 2, timeout: float = 15) -> Stream:
    """Liefert die Videoquelle hinter `url` oder wirft NoStreamFound / ProtectedStream / StreamError."""
    if not url.startswith(("http://", "https://")):
        raise StreamError("Nur http- und https-Links werden unterstützt.")
    headers = dict(headers or {})
    first = probe(url, headers, timeout)
    direct = _as_stream(first, headers, None, timeout)
    if direct:
        return direct
    if first.kind != "html":
        raise NoStreamFound(f"Unter dem Link liegt weder ein Video noch eine Webseite (Inhaltstyp: {first.content_type or 'unbekannt'}).")
    return _from_page(first.url, headers, depth, timeout, tried=[])


def _from_page(page_url: str, headers: dict[str, str], depth: int, timeout: float, tried: list[str]) -> Stream:
    text, page_url = _fetch_text(page_url, headers, timeout)
    media, iframes, subs, title = find_candidates(text, page_url)
    # Viele Server liefern Videos nur mit passendem Referer (Herkunftsseite) aus
    ref = {**headers, "Referer": page_url, "User-Agent": headers.get("User-Agent", USER_AGENT)}
    protected: ProtectedStream | None = None
    for cand in media:
        if cand in tried:
            continue
        tried.append(cand)
        try:
            s = _as_stream(probe(cand, ref, timeout), ref, page_url, timeout)
        except ProtectedStream as e:
            protected = e
            continue
        except StreamError:
            continue
        if s:
            s.title = title or None
            s.subtitles = subs
            return s
    if depth > 0:
        for frame in iframes:
            if frame in tried:
                continue
            tried.append(frame)
            try:
                s = _from_page(frame, {**headers, "Referer": page_url}, depth - 1, timeout, tried)
            except ProtectedStream as e:
                protected = e
                continue
            except StreamError:
                continue
            s.title = s.title or title or None
            s.subtitles = s.subtitles or subs
            return s
    if protected:
        raise protected
    hint = " Der Player wird vermutlich erst per JavaScript geladen – probiere die Webansicht." if not media else ""
    raise NoStreamFound(f"In der Webseite wurde kein abspielbarer Video-Link gefunden.{hint}", is_page=True, tried=tried)
