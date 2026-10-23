// Link-Quellen: eigene Stream-Links mit Platzhaltern, die pro Episode ausgefüllt werden,
// z. B. http://192.168.1.10:8080/anime/{slug}/S{season:02}E{episode:02}.m3u8
// Beim Abspielen werden die aktiven Quellen von oben nach unten geprüft; die erste erreichbare gewinnt.
import { useEffect, useState } from "react";
import { api, Episode, Series } from "../api";
import { normalizeStreamUrl, StreamSpec } from "./stream";

export type LinkSource = { id: string; name: string; template: string; enabled: boolean };

/** Werte, die in eine Vorlage eingesetzt werden. */
export type LinkValues = { title: string; altTitle: string | null; season: number; episode: number; anilistId: number | null };

export const PLACEHOLDERS = ["{title}", "{slug}", "{alt_slug}", "{season}", "{episode}", "{episode:02}", "{anilist_id}"] as const;

const KEY = "nexus.linkSources";
const CHANGED = "nexus:link-sources";

// ---------------------------------------------------------------------------
// Speicher (lokal in diesem Fenster, wie Stream-Verlauf und Positionen)
// ---------------------------------------------------------------------------

export function linkSources(): LinkSource[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LinkSource[]) : [];
  } catch {
    return [];
  }
}

function store(list: LinkSource[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* Speicher nicht verfügbar */
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Aktuelle Liste, aktualisiert sich bei jeder Änderung. */
export function useLinkSources() {
  const [list, setList] = useState(linkSources);
  useEffect(() => {
    const h = () => setList(linkSources());
    window.addEventListener(CHANGED, h);
    return () => window.removeEventListener(CHANGED, h);
  }, []);
  return list;
}

export function addLinkSource(name: string, template: string): LinkSource {
  const tpl = template.trim();
  previewTemplate(tpl); // wirft bei ungültiger Vorlage
  let host = "";
  try {
    host = new URL(tpl.replace(/\{[^}]*\}/g, "x")).host;
  } catch {
    /* bereits geprüft */
  }
  const source: LinkSource = { id: crypto.randomUUID(), name: name.trim() || host || "Link-Quelle", template: tpl, enabled: true };
  store([...linkSources(), source]);
  return source;
}

export const removeLinkSource = (id: string) => store(linkSources().filter((s) => s.id !== id));
export const setLinkSourceEnabled = (id: string, enabled: boolean) => store(linkSources().map((s) => (s.id === id ? { ...s, enabled } : s)));

export function moveLinkSource(id: string, delta: number) {
  const list = linkSources();
  const i = list.findIndex((s) => s.id === id);
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  if (i < 0 || i === j) return;
  const [item] = list.splice(i, 1);
  list.splice(j, 0, item);
  store(list);
}

// ---------------------------------------------------------------------------
// Vorlagen
// ---------------------------------------------------------------------------

const slug = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ'’`]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Setzt die Werte ein. `{episode:02}` (oder `{episode:02d}`) füllt mit Nullen auf. Wirft bei unbekannten Platzhaltern. */
export function renderTemplate(template: string, v: LinkValues): string {
  const values: Record<string, string | number | null> = {
    title: encodeURIComponent(v.title),
    slug: slug(v.title),
    alt_slug: v.altTitle ? slug(v.altTitle) : slug(v.title),
    season: v.season,
    episode: v.episode,
    anilist_id: v.anilistId,
  };
  const out = template.replace(/\{(\w+)(?::0?(\d+)d?)?\}/g, (_m, name: string, width?: string) => {
    if (!(name in values)) throw new Error(`Unbekannter Platzhalter {${name}}`);
    const value = values[name];
    if (value == null) throw new Error(`Für {${name}} gibt es bei dieser Serie keinen Wert`);
    return width ? String(value).padStart(Number(width), "0") : String(value);
  });
  if (/[{}]/.test(out)) throw new Error("Die Vorlage enthält eine nicht geschlossene Klammer");
  return normalizeStreamUrl(out);
}

export const previewTemplate = (template: string) =>
  renderTemplate(template, { title: "Frieren: Beyond Journey’s End", altTitle: "Sousou no Frieren", season: 1, episode: 3, anilistId: 154587 });

// ---------------------------------------------------------------------------
// Auflösen für eine Episode
// ---------------------------------------------------------------------------

/** Kurze Erreichbarkeitsprüfung über das Backend (kein CORS, lädt keine Videodaten). */
async function reachable(url: string): Promise<boolean> {
  try {
    const r = await api.pluginHttp({ url, method: "HEAD", timeoutMs: 6000 });
    // Manche Server kennen HEAD nicht – dann zählt, dass sie überhaupt antworten.
    return r.status < 400 || r.status === 405 || r.status === 501;
  } catch {
    return false;
  }
}

export type LinkResolution = { spec: StreamSpec; source: LinkSource } | { spec: null; tried: string[] };

/** Für eine Episode aus der Bibliothek (Datei vorhanden oder nicht verfügbar). */
export function resolveEpisodeLink(e: Episode, series: Series | null): Promise<LinkResolution> {
  const title = series?.title ?? e.seriesTitle ?? e.parsedSeries;
  if (!title || e.episode == null) throw new Error("Für diese Episode fehlen Serientitel oder Folgennummer.");
  return resolveLink({ title, altTitle: series?.altTitle ?? null, season: e.season ?? 1, episode: e.episode, anilistId: series?.anilistId ?? null }, series?.id ?? null, e.title);
}

/** Für eine beliebige Folge – auch ohne Datei in der Bibliothek. */
export async function resolveLink(values: LinkValues, seriesId: string | null, episodeTitle?: string | null): Promise<LinkResolution> {
  const tried: string[] = [];
  for (const source of linkSources().filter((s) => s.enabled)) {
    let url: string;
    try {
      url = renderTemplate(source.template, values);
    } catch {
      continue;
    }
    tried.push(url);
    if (await reachable(url)) {
      const code = `S${String(values.season).padStart(2, "0")}E${String(values.episode).padStart(2, "0")}`;
      return {
        source,
        spec: {
          url,
          title: episodeTitle ? `${code} · ${episodeTitle}` : code,
          subtitle: `${values.title} · ${source.name}`,
          key: `link:${seriesId ?? values.title}:${values.season}:${values.episode}`,
        },
      };
    }
  }
  return { spec: null, tried };
}
