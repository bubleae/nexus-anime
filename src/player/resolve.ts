// Vor der Wiedergabe eines Stream-Links: Ist das ein Video, ein HLS-Manifest oder eine Webseite?
// Webseiten werden an die Resolver der Plugins gegeben (z. B. den Python-Stream-Extractor), die den
// eigentlichen Video-Link heraussuchen. Findet keiner etwas, zeigt der Player die Webansicht als Ausweg an.
import { api, errorText } from "../api";
import { t } from "../i18n";
import { streamResolvers } from "../plugins/host";
import { isHls, normalizeStreamUrl, StreamSpec } from "./stream";

export type Resolution = { kind: "play"; spec: StreamSpec } | { kind: "page"; url: string; message: string };

const DIRECT = /\.(mp4|m4v|webm|mkv|mov|ogv|m3u8)($|[?#])/i;
const RESOLVER_TIMEOUT = 60_000;

const looksDirect = (s: StreamSpec) => !!s.type || isHls(s) || DIRECT.test(s.url);

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => (timer = window.setTimeout(() => reject(new Error(t("stream.resolverTimeout", { p: name }))), ms))),
  ]).finally(() => clearTimeout(timer));
}

/** Stream-Beschreibung eines Resolvers prüfen und mit den Angaben des Aufrufers zusammenführen. */
function merge(requested: StreamSpec, raw: unknown): StreamSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<StreamSpec>;
  if (typeof r.url !== "string") return null;
  return {
    ...r,
    url: normalizeStreamUrl(r.url),
    type: r.type === "hls" || r.type === "file" ? r.type : undefined,
    title: requested.title ?? r.title,
    subtitle: requested.subtitle ?? r.subtitle,
    subtitles: requested.subtitles?.length ? requested.subtitles : r.subtitles,
    startAt: requested.startAt,
    // Position unter dem eingegebenen Link merken – der gefundene kann sich ändern (Tokens)
    key: requested.key ?? requested.url,
    page: r.page ?? requested.url,
  };
}

/** Bestimmt, was abgespielt werden soll. Wirft nur bei Fehlern der Resolver mit klarer Meldung (z. B. DRM). */
export async function resolveStream(requested: StreamSpec): Promise<Resolution> {
  if (looksDirect(requested)) return { kind: "play", spec: requested };
  let probe;
  try {
    probe = await api.probeStream(requested.url);
  } catch {
    // Nicht erreichbar: der Player zeigt dann den passenden Netzwerkfehler
    return { kind: "play", spec: requested };
  }
  if (probe.kind === "hls" || probe.kind === "file") return { kind: "play", spec: { ...requested, type: probe.kind } };
  if (probe.kind === "dash") return { kind: "page", url: requested.url, message: t("stream.dash") };
  if (probe.kind !== "html") return { kind: "play", spec: requested };

  const problems: string[] = [];
  for (const r of streamResolvers()) {
    try {
      const spec = merge(requested, await withTimeout(Promise.resolve(r.resolve(requested.url)), RESOLVER_TIMEOUT, r.name));
      if (spec) return { kind: "play", spec };
    } catch (e) {
      problems.push(`${r.name}: ${errorText(e)}`);
    }
  }
  const message = [streamResolvers().length ? t("stream.pageNothingFound") : t("stream.pageNoResolver"), ...problems].join("\n");
  return { kind: "page", url: requested.url, message };
}

/** Nach einem Formatfehler des Video-Elements: War der Link in Wahrheit eine Webseite? */
export async function isWebPage(url: string): Promise<boolean> {
  try {
    return (await api.probeStream(url)).kind === "html";
  } catch {
    return false;
  }
}
