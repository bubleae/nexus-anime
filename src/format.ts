// Formatierung immer mit deutscher bzw. gewählter App-Sprache – unabhängig von der Windows-Systemsprache.
import { getLanguage, t } from "./i18n";
import type { Episode } from "./api";

const locale = () => (getLanguage() === "en" ? "en-GB" : "de-DE");

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(locale(), { maximumFractionDigits: i >= 3 ? 2 : 1 })} ${units[i]}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return "–:–";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function formatMinutes(sec: number | null | undefined): string {
  if (!sec) return "";
  const m = Math.round(sec / 60);
  if (m < 1) return "< 1 Min.";
  return m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60} Min.` : `${m} Min.`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "–";
  return d.toLocaleString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("time.justNow");
  if (diff < 3600) return t("time.minutes", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("time.hours", { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 30) return t("time.days", { n: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString(locale());
}

export const pad = (n: number | null | undefined, len = 2) => (n == null ? "?" : String(n).padStart(len, "0"));

/** Kurze Kennung wie „S01E05“, „Special 2“ oder „Film“. */
export function episodeCode(e: Episode): string {
  const ep = e.episode != null ? (e.episodeEnd ? `${pad(e.episode)}-${pad(e.episodeEnd)}` : pad(e.episode)) : null;
  switch (e.kind) {
    case "movie":
      return ep ? `${t("kind.movie")} ${e.episode}` : t("kind.movie");
    case "special":
    case "ova":
    case "extra":
      return ep ? `${t(`kind.${e.kind}`)} ${ep}` : t(`kind.${e.kind}`);
    default:
      return ep ? `S${pad(e.season ?? 1)}E${ep}` : t("ep.noNumber");
  }
}

export function episodeTitle(e: Episode): string {
  if (e.title) return e.title;
  if (e.kind === "movie") return e.seriesTitle ?? e.fileName;
  if (e.episode != null) return t("ep.noTitle", { n: e.episode });
  return e.fileName;
}

export const progressOf = (e: Episode) => (e.watched ? 1 : e.duration && e.position ? Math.min(1, e.position / e.duration) : 0);
