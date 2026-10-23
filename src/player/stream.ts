// Wiedergabe eigener Stream-Links (z. B. Jellyfin, Plex, NAS, Medienserver im Heimnetz).
// Unterstützt direkte Videodateien (MP4/WebM/MKV …) und HLS (.m3u8, über hls.js).
import { api, Episode, PlaybackInfo, SubtitleTrack } from "../api";

export type StreamSubtitle = { url: string; label?: string; lang?: string };

/** Beschreibung eines Streams – von der Oberfläche oder von Plugins (`nexus.player.playUrl`). */
export type StreamSpec = {
  url: string;
  title?: string;
  /** zweite Zeile im Player, z. B. Serienname oder Server */
  subtitle?: string;
  subtitles?: StreamSubtitle[];
  /** Startposition in Sekunden (überschreibt die gemerkte Position) */
  startAt?: number;
  /** Schlüssel für die gemerkte Position und Ereignisse; Standard: die URL */
  key?: string;
  /** "hls" oder "file" erzwingen; sonst anhand der URL erkannt */
  type?: "hls" | "file";
  /** Webseite, auf der der Link gefunden wurde (Stream-Extractor / Webansicht) */
  page?: string;
  /** Header, die der Server verlangt (z. B. Referer). Der integrierte Player kann sie nicht senden – externe Player schon. */
  headers?: Record<string, string>;
};

/** Prüft die Adresse. Erlaubt sind nur http(s)-Links. */
export function normalizeStreamUrl(raw: string): string {
  const url = raw.trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Das ist kein gültiger Link. Erwartet wird z. B. http://192.168.1.10:8096/…");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Nur http- und https-Links können abgespielt werden.");
  return u.toString();
}

export const isHls = (s: StreamSpec) => s.type === "hls" || (s.type !== "file" && /\.m3u8($|[?#])/i.test(s.url)) || /[?&](container|format)=m3u8/i.test(s.url);
export const streamKey = (s: StreamSpec) => s.key ?? s.url;

// ---------------------------------------------------------------------------
// Gemerkte Positionen und Verlauf (nur in diesem Fenster, nicht in der Bibliothek)
// ---------------------------------------------------------------------------

const POS_KEY = "nexus.streamPositions";
const RECENT_KEY = "nexus.recentStreams";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function savedPosition(key: string): number {
  return readJson<Record<string, { pos: number }>>(POS_KEY, {})[key]?.pos ?? 0;
}
export function savePosition(key: string, pos: number, duration: number | null, finished: boolean) {
  const all = readJson<Record<string, { pos: number; duration: number | null; at: number }>>(POS_KEY, {});
  if (finished) delete all[key];
  else all[key] = { pos, duration, at: Date.now() };
  // Nur die letzten 200 Einträge behalten
  const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
  writeJson(POS_KEY, Object.fromEntries(entries));
}

export type RecentStream = { url: string; title?: string; subtitleUrl?: string; at: number };
export const recentStreams = () => readJson<RecentStream[]>(RECENT_KEY, []);
export function rememberStream(s: RecentStream) {
  writeJson(RECENT_KEY, [s, ...recentStreams().filter((x) => x.url !== s.url)].slice(0, 12));
}
export function forgetStream(url: string) {
  writeJson(RECENT_KEY, recentStreams().filter((x) => x.url !== url));
}

// ---------------------------------------------------------------------------
// Darstellung im Player
// ---------------------------------------------------------------------------

function titleFromUrl(url: string) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return last && !/^(stream|master|index|main)(\.\w+)?$/i.test(last) ? last : u.host;
  } catch {
    return url;
  }
}

/** Baut die Wiedergabe-Infos, die der Player sonst vom Backend bekommt. */
export function streamPlaybackInfo(s: StreamSpec): PlaybackInfo {
  const key = streamKey(s);
  const title = s.title?.trim() || titleFromUrl(s.url);
  const episode: Episode = {
    id: `stream:${key}`,
    seriesId: null,
    seriesTitle: s.subtitle ?? null,
    filePath: s.url,
    originPath: null,
    fileName: title,
    fileSize: 0,
    fileMtime: 0,
    sourceId: null,
    season: null,
    episode: null,
    episodeEnd: null,
    kind: "episode",
    title,
    resolution: null,
    audioHints: [],
    subtitleHints: [],
    version: null,
    parsedSeries: null,
    confidence: 1,
    manual: true,
    sortIndex: null,
    available: true,
    missing: false,
    missingSince: null,
    ignored: false,
    duration: null,
    position: s.startAt ?? savedPosition(key),
    watched: false,
    watchedAt: null,
    lastPlayedAt: null,
    playCount: 0,
    thumbnailPath: null,
    addedAt: new Date().toISOString(),
  };
  const subtitles: SubtitleTrack[] = (s.subtitles ?? []).map((x, i) => ({
    id: `stream:${i}`,
    label: x.label ?? x.lang ?? `Untertitel ${i + 1}`,
    language: x.lang ?? null,
    source: "external",
    codec: /\.vtt($|[?#])/i.test(x.url) ? "vtt" : "srt",
    supported: true,
    default: i === 0,
  }));
  return { episode, series: null, previousId: null, nextId: null, next: null, subtitles };
}

/** SRT → WebVTT (einfache Umwandlung, reicht für übliche SRT-Dateien). */
export function srtToVtt(srt: string) {
  const body = srt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}

/** Lädt eine Untertitel-URL (über das Backend, damit keine CORS-Sperren greifen). */
export async function fetchSubtitle(url: string): Promise<string> {
  const r = await api.pluginHttp({ url: normalizeStreamUrl(url), timeoutMs: 20000 });
  if (r.status < 200 || r.status >= 300) throw new Error(`Untertitel konnten nicht geladen werden (HTTP ${r.status})`);
  const text = r.body.replace(/^﻿/, "");
  if (/^WEBVTT/.test(text.trimStart())) return text;
  if (/^\[Script Info\]/i.test(text.trimStart())) throw new Error("ASS/SSA-Untertitel per Link werden nicht unterstützt – bitte SRT oder VTT verwenden.");
  return srtToVtt(text);
}

/** Hängt einen HLS-Stream an das Video-Element. Gibt eine Aufräumfunktion zurück. */
export async function attachHls(video: HTMLVideoElement, url: string, onFatal: (msg: string) => void): Promise<() => void> {
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) {
    // Fallback: eingebaute Wiedergabe versuchen
    video.src = url;
    return () => video.removeAttribute("src");
  }
  const hls = new Hls({ enableWorker: true });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
      return;
    }
    const status = (data.response as { code?: number } | undefined)?.code;
    onFatal(
      data.type === Hls.ErrorTypes.NETWORK_ERROR
        ? `Der Stream konnte nicht geladen werden${status ? ` (HTTP ${status})` : ""}. Ist der Server erreichbar und erlaubt er Zugriffe von anderen Programmen (CORS)?`
        : `HLS-Fehler: ${data.details}`,
    );
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  return () => hls.destroy();
}
