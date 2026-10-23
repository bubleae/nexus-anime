// Suchquellen von Plugins auf der Seite „Entdecken“: Treffer als Kacheln, Detailseite mit Episoden.
// Plugins liefern JSON; Felder dürfen in snake_case (cover_url) oder camelCase (coverUrl) kommen.
// Episoden mit `stream_url` laufen im integrierten Player, Episoden mit `url` öffnen sich im Browser.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Compass, ExternalLink, Play } from "lucide-react";
import { api, errorText } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { Empty, fallbackGradient, Loading } from "../components/ui";
import { DiscoverSourceContribution } from "../plugins/host";
import { RemoteCover } from "./Discover";
import type { StreamSubtitle } from "../player/stream";

// ---------------------------------------------------------------------------
// Normalisieren der Plugin-Daten
// ---------------------------------------------------------------------------

export type SourceEpisode = {
  number: number | null;
  season: number | null;
  title: string | null;
  description: string | null;
  thumbnail: string | null;
  duration: number | null;
  streamUrl: string | null;
  url: string | null;
  subtitles: StreamSubtitle[];
};

export type SourceItem = {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  coverUrl: string | null;
  bannerUrl: string | null;
  year: string | null;
  genres: string[];
  url: string | null;
  episodes: SourceEpisode[] | null;
  /** Das Original-Objekt des Plugins (wird an `details` zurückgegeben) */
  raw: unknown;
};

type Obj = Record<string, unknown>;
const pick = (o: Obj, ...keys: string[]) => {
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return null;
};
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const httpUrl = (v: unknown) => {
  const s = str(v)?.trim();
  return s && /^https?:\/\//i.test(s) ? s : null;
};

function normEpisode(raw: unknown, index: number): SourceEpisode {
  const o = (raw && typeof raw === "object" ? raw : {}) as Obj;
  const subs = pick(o, "subtitles", "subs");
  return {
    number: num(pick(o, "number", "episode", "ep", "index")) ?? index + 1,
    season: num(pick(o, "season")),
    title: str(pick(o, "title", "name")),
    description: str(pick(o, "description", "overview", "summary")),
    thumbnail: httpUrl(pick(o, "thumbnail", "thumbnail_url", "thumbnailUrl", "image", "image_url", "imageUrl")),
    duration: num(pick(o, "duration", "runtime")),
    streamUrl: httpUrl(pick(o, "stream_url", "streamUrl", "stream")),
    url: httpUrl(pick(o, "url", "link", "page_url", "pageUrl")),
    subtitles: Array.isArray(subs)
      ? subs
          .map((s) => (typeof s === "string" ? { url: s } : (s as Obj)))
          .filter((s) => httpUrl(s.url))
          .map((s) => ({ url: String(s.url), label: str(pick(s as Obj, "label", "name")) ?? undefined, lang: str(pick(s as Obj, "lang", "language")) ?? undefined }))
      : [],
  };
}

export function normItem(raw: unknown, index = 0): SourceItem {
  const o = (raw && typeof raw === "object" ? raw : { title: String(raw) }) as Obj;
  const eps = pick(o, "episodes");
  const genres = pick(o, "genres", "tags");
  return {
    id: str(pick(o, "id", "key", "url", "title")) ?? String(index),
    title: str(pick(o, "title", "name")) ?? "?",
    subtitle: str(pick(o, "subtitle", "original_title", "originalTitle", "alt_title", "altTitle")),
    description: str(pick(o, "description", "overview", "summary", "synopsis")),
    coverUrl: httpUrl(pick(o, "cover_url", "coverUrl", "cover", "poster", "poster_url", "posterUrl", "image", "image_url", "imageUrl", "thumbnail")),
    bannerUrl: httpUrl(pick(o, "banner_url", "bannerUrl", "banner", "backdrop", "backdrop_url", "backdropUrl")),
    year: str(pick(o, "year", "release_year", "releaseYear")),
    genres: Array.isArray(genres) ? genres.map(String) : [],
    url: httpUrl(pick(o, "url", "link", "page_url", "pageUrl")),
    episodes: Array.isArray(eps) ? eps.map(normEpisode) : null,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Suche über alle Quellen
// ---------------------------------------------------------------------------

export type SourceState = { loading: boolean; items: SourceItem[] | null; error: string | null };

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(t("discover.sourceTimeout"))), ms))]);

/** Durchsucht alle Quellen parallel (verzögert, damit nicht jeder Tastendruck eine Suche auslöst). */
export function useSourceSearch(sources: DiscoverSourceContribution[], query: string) {
  const [state, setState] = useState<Record<string, SourceState>>({});
  const run = useRef(0);
  const key = sources.map((s) => s.uid).join("|");
  useEffect(() => {
    const q = query.trim();
    const id = ++run.current;
    if (q.length < 2 || sources.length === 0) {
      setState({});
      return;
    }
    const h = setTimeout(() => {
      setState((prev) => Object.fromEntries(sources.map((s) => [s.uid, { loading: true, items: prev[s.uid]?.items ?? null, error: null }])));
      for (const s of sources) {
        withTimeout(Promise.resolve().then(() => s.search(q)), 30000)
          .then((res) => {
            if (run.current !== id) return;
            const list = Array.isArray(res) ? res : [];
            setState((prev) => ({ ...prev, [s.uid]: { loading: false, items: list.map(normItem), error: null } }));
          })
          .catch((e) => {
            if (run.current !== id) return;
            api.log("warn", `Suchquelle ${s.pluginId}/${s.id}: ${errorText(e)}`);
            setState((prev) => ({ ...prev, [s.uid]: { loading: false, items: null, error: errorText(e) } }));
          });
      }
    }, 600);
    return () => clearTimeout(h);
  }, [query, key]);
  return state;
}

// ---------------------------------------------------------------------------
// Kacheln
// ---------------------------------------------------------------------------

function SourceCard({ item, onOpen }: { item: SourceItem; onOpen: () => void }) {
  return (
    <div className="card" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div style={{ position: "relative" }}>
        <RemoteCover src={item.coverUrl} title={item.title} />
        <div className="card-overlay">
          <div className="play-bubble">
            <Play size={20} />
          </div>
        </div>
      </div>
      <div className="card-info">
        <div className="card-title">{item.title}</div>
        <div className="card-meta">
          {[item.year, item.subtitle, item.episodes ? t("meta.episodes", { n: item.episodes.length }) : null].filter(Boolean).join(" · ")}
        </div>
      </div>
    </div>
  );
}

export function SourceSection({ source, state, onOpen }: { source: DiscoverSourceContribution; state: SourceState | undefined; onOpen: (item: SourceItem) => void }) {
  return (
    <section className="source-section">
      <div className="source-head">
        <h2>
          {source.icon && <span className="plugin-icon">{source.icon}</span>} {source.name}
        </h2>
        {state?.items && <span className="count">{state.items.length}</span>}
        {state?.loading && <div className="spinner" />}
      </div>
      {state?.error && (
        <div className="plugin-error">
          <AlertTriangle size={15} /> <span>{t("discover.sourceError")}: {state.error}</span>
        </div>
      )}
      {state?.items && state.items.length === 0 && <div className="hint source-empty">{t("discover.noHits")}</div>}
      {state?.items && state.items.length > 0 && (
        <div className="grid" style={{ opacity: state.loading ? 0.6 : 1, transition: "opacity .2s" }}>
          {state.items.map((it, i) => (
            <SourceCard key={`${it.id}:${i}`} item={it} onOpen={() => onOpen(it)} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detailseite
// ---------------------------------------------------------------------------

export function SourceDetailView({ source, item, back }: { source: DiscoverSourceContribution; item: SourceItem; back: () => void }) {
  const { fail, toast, playStream } = useStore();
  const [detail, setDetail] = useState<SourceItem | null>(source.details ? null : item);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source.details) return;
    let alive = true;
    withTimeout(Promise.resolve().then(() => source.details!(item.raw)), 30000)
      .then((r) => {
        if (!alive) return;
        // Details ergänzen den Treffer: nur Felder übernehmen, die das Plugin wirklich liefert
        const o = (r && typeof r === "object" ? r : {}) as Obj;
        const d = normItem(o);
        const given = (...keys: string[]) => keys.some((k) => o[k] != null && o[k] !== "");
        setDetail({
          ...item,
          title: given("title", "name") ? d.title : item.title,
          subtitle: d.subtitle ?? item.subtitle,
          description: d.description ?? item.description,
          coverUrl: d.coverUrl ?? item.coverUrl,
          bannerUrl: d.bannerUrl ?? item.bannerUrl,
          year: d.year ?? item.year,
          genres: d.genres.length ? d.genres : item.genres,
          url: d.url ?? item.url,
          episodes: d.episodes ?? item.episodes,
        });
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [source.uid, item.id]);

  const d = detail ?? item;
  const episodes = detail?.episodes ?? null;
  const playable = episodes?.find((e) => e.streamUrl) ?? null;

  const playEpisode = (e: SourceEpisode) => {
    if (e.streamUrl) {
      try {
        playStream({
          url: e.streamUrl,
          title: e.title ?? t("discover.episodeCode", { n: e.number ?? "?" }),
          subtitle: d.title,
          subtitles: e.subtitles.length ? e.subtitles : undefined,
          key: `${source.pluginId}:${source.id}:${d.id}:${e.season ?? ""}:${e.number ?? ""}`,
        });
      } catch (err) {
        fail(err);
      }
    } else if (e.url) api.openLink(e.url).catch(fail);
    else toast("info", t("discover.notPlayable"));
  };

  return (
    <div className="page flush">
      <div className="detail-hero">
        {d.bannerUrl ? (
          <div className="hero-bg" style={{ backgroundImage: `url("${d.bannerUrl}")` }} />
        ) : d.coverUrl ? (
          <div className="hero-bg blurred" style={{ backgroundImage: `url("${d.coverUrl}")` }} />
        ) : (
          <div className="hero-bg" style={{ background: fallbackGradient(d.title) }} />
        )}
        <div className="detail-head">
          <div className="detail-cover">
            <RemoteCover src={d.coverUrl} title={d.title} />
          </div>
          <div className="detail-info">
            <button className="btn glass small" style={{ marginBottom: 16 }} onClick={back}>
              <ArrowLeft size={15} /> {t("discover.backToResults")}
            </button>
            <h1 className="detail-title">{d.title}</h1>
            {d.subtitle && <div className="detail-alt">{d.subtitle}</div>}
            <div className="detail-meta">
              <span className="tag accent">
                {source.icon && <span className="plugin-icon">{source.icon}</span>} {source.name}
              </span>
              {d.year && <span className="tag">{d.year}</span>}
              {d.genres.map((g) => <span key={g} className="tag">{g}</span>)}
            </div>
            {d.description && <p className="detail-desc clamped">{d.description}</p>}
            <div className="btn-row">
              {playable && (
                <button className="btn white large" onClick={() => playEpisode(playable)}>
                  <Play size={19} fill="currentColor" /> {t("discover.playFirst")}
                </button>
              )}
              {d.url && (
                <button className="btn glass large" onClick={() => api.openLink(d.url!).catch(fail)}>
                  <ExternalLink size={18} /> {t("discover.openSource")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="tabs">
        <button className="tab active">
          {t("common.episodes")}
          {episodes && <span className="n">{episodes.length}</span>}
        </button>
      </div>
      {!detail && !error && <Loading />}
      {error && <Empty icon={<Compass size={30} />} title={t("discover.sourceError")} text={error} />}
      {detail && (!episodes || episodes.length === 0) && <Empty icon={<Compass size={30} />} title={t("discover.noEpisodes")} />}
      {episodes && episodes.length > 0 && (
        <div className="episodes">
          {episodes.map((e, i) => {
            const clickable = !!(e.streamUrl || e.url);
            return (
              <div key={`${e.season ?? ""}:${e.number ?? i}:${i}`} className="ep" style={{ cursor: clickable ? "pointer" : "default" }} onClick={() => playEpisode(e)}>
                <div className="num">{e.number ?? i + 1}</div>
                <div className="ethumb">
                  {e.thumbnail ? <img src={e.thumbnail} alt="" loading="lazy" /> : <div className="ph"><Play size={22} /></div>}
                  {clickable && <div className="play-over">{e.streamUrl ? <Play size={24} fill="#fff" /> : <ExternalLink size={24} />}</div>}
                </div>
                <div className="etext">
                  <div className="etitle">
                    <span className="t">{e.title ?? t("ep.noTitle", { n: e.number ?? i + 1 })}</span>
                  </div>
                  <div className="esub">
                    <span>{e.season != null ? `S${String(e.season).padStart(2, "0")}E${String(e.number ?? i + 1).padStart(2, "0")}` : t("discover.episodeCode", { n: e.number ?? i + 1 })}</span>
                    {e.duration ? <span>{Math.round(e.duration / 60)} min</span> : null}
                  </div>
                  {e.description && <div className="hint" style={{ fontSize: 12.5, marginTop: 4 }}>{e.description}</div>}
                </div>
                <div className="eactions">
                  {e.streamUrl ? (
                    <button className="btn small primary" onClick={(ev) => { ev.stopPropagation(); playEpisode(e); }}>
                      <Play size={14} fill="currentColor" /> {t("player.play")}
                    </button>
                  ) : e.url ? (
                    <button className="btn small" onClick={(ev) => { ev.stopPropagation(); api.openLink(e.url!).catch(fail); }}>
                      <ExternalLink size={14} /> {t("discover.openSource")}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
