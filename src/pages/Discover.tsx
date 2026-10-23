// „Entdecken“: Anime über AniList suchen, als Kacheln anzeigen, Episodenliste ansehen
// und mit einem Klick als Online-Serie in die Bibliothek übernehmen. Nur Metadaten – keine Videos.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Compass, ExternalLink, Library, Play, Plus, Search as SearchIcon } from "lucide-react";
import { AnimeMatch, api, DiscoverDetail, errorText } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { Empty, fallbackGradient, initials, Loading, providerOf } from "../components/ui";

const LAST_QUERY_KEY = "nexus.discover.q";

function RemoteCover({ src, title }: { src: string | null; title: string }) {
  const [ok, setOk] = useState(true);
  return (
    <div className="cover">
      {src && ok ? (
        <img src={src} alt="" loading="lazy" onError={() => setOk(false)} draggable={false} />
      ) : (
        <div className="cover-fallback" style={{ background: fallbackGradient(title) }}>
          <div className="initials">{initials(title)}</div>
          <div className="ft">{title}</div>
        </div>
      )}
    </div>
  );
}

const displayTitle = (m: AnimeMatch) => m.titleEnglish ?? m.titleRomaji ?? m.titleNative ?? "?";

function DiscoverCard({ m, inLibrary, onOpen }: { m: AnimeMatch; inLibrary: boolean; onOpen: () => void }) {
  return (
    <div className="card" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div style={{ position: "relative" }}>
        <RemoteCover src={m.coverExtraLarge ?? m.coverLarge} title={displayTitle(m)} />
        <div className="card-overlay">
          <div className="play-bubble">
            <SearchIcon size={20} />
          </div>
        </div>
        <div className="badges">
          <span>{inLibrary && <span className="badge new"><Check size={12} /> {t("discover.inLibrary")}</span>}</span>
        </div>
      </div>
      <div className="card-info">
        <div className="card-title">{displayTitle(m)}</div>
        <div className="card-meta">
          {[m.year, m.format?.replace("_", " "), m.episodes ? t("meta.episodes", { n: m.episodes }) : null].filter(Boolean).join(" · ")}
        </div>
      </div>
    </div>
  );
}

function DiscoverDetailView({ m, back }: { m: AnimeMatch; back: () => void }) {
  const { series, fail, toast, navigate, reloadSeries } = useStore();
  const [detail, setDetail] = useState<DiscoverDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const local = series.find((s) => s.anilistId === m.anilistId) ?? null;
  const [localEps, setLocalEps] = useState<Set<number>>(new Set());

  useEffect(() => {
    api.discoverEpisodes(m.anilistId).then(setDetail).catch((e) => setError(errorText(e)));
  }, [m.anilistId]);
  useEffect(() => {
    if (!local) return;
    api.seriesDetail(local.id)
      .then((d) => setLocalEps(new Set(d.episodes.filter((e) => e.kind === "episode" && e.episode != null && e.available && !e.missing).map((e) => e.episode!))))
      .catch(() => {});
  }, [local?.id]);

  const add = async () => {
    setBusy(true);
    try {
      const id = await api.discoverAdd(m);
      await reloadSeries();
      toast("success", t("discover.added"), displayTitle(m));
      navigate({ name: "series", params: { id } });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const links = (m.streamingLinks ?? []).slice(0, 8);
  const hostName = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };

  return (
    <div className="page flush">
      <div className="detail-hero">
        {m.banner ? (
          <div className="hero-bg" style={{ backgroundImage: `url("${m.banner}")` }} />
        ) : m.coverExtraLarge || m.coverLarge ? (
          <div className="hero-bg blurred" style={{ backgroundImage: `url("${m.coverExtraLarge ?? m.coverLarge}")` }} />
        ) : (
          <div className="hero-bg" style={{ background: fallbackGradient(displayTitle(m)) }} />
        )}
        <div className="detail-head">
          <div className="detail-cover">
            <RemoteCover src={m.coverExtraLarge ?? m.coverLarge} title={displayTitle(m)} />
          </div>
          <div className="detail-info">
            <button className="btn glass small" style={{ marginBottom: 16 }} onClick={back}>
              <ArrowLeft size={15} /> {t("discover.backToResults")}
            </button>
            <h1 className="detail-title">{displayTitle(m)}</h1>
            {m.titleRomaji && m.titleRomaji !== displayTitle(m) && <div className="detail-alt">{m.titleRomaji}</div>}
            <div className="detail-meta">
              {m.year && <span className="tag">{m.year}</span>}
              {m.format && <span className="tag">{m.format.replace("_", " ")}</span>}
              {m.score && <span className="tag accent">★ {m.score} %</span>}
              {m.studio && <span className="tag">{m.studio}</span>}
              {m.genres.map((g) => <span key={g} className="tag">{g}</span>)}
            </div>
            {m.description && <p className="detail-desc clamped">{m.description}</p>}
            <div className="btn-row">
              {local ? (
                <button className="btn white large" onClick={() => navigate({ name: "series", params: { id: local.id } })}>
                  <Library size={19} /> {t("discover.openInLibrary")}
                </button>
              ) : (
                <button className="btn white large" disabled={busy} onClick={add}>
                  <Plus size={19} /> {t("discover.add")}
                </button>
              )}
              <button className="btn glass large" onClick={() => api.openLink(`https://anilist.co/anime/${m.anilistId}`).catch(fail)}>
                <ExternalLink size={18} /> AniList
              </button>
            </div>
            {links.length > 0 && (
              <div className="watch-links">
                <span className="wl-label">{t("link.whereToWatch")}</span>
                {links.map((u) => (
                  <button key={u} className={`provider-chip p-${providerOf(u).key}`} onClick={() => api.openLink(u).catch(fail)}>
                    <span className="dot" /> {providerOf(u).name} <ExternalLink size={13} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="tabs">
        <button className="tab active">
          {t("common.episodes")}
          {detail && <span className="n">{detail.episodes.length}{detail.total && detail.aired != null && detail.aired < detail.total ? ` / ${detail.total}` : ""}</span>}
        </button>
      </div>
      {!detail && !error && <Loading />}
      {error && <Empty icon={<Compass size={30} />} title={t("meta.offline")} text={error} />}
      {detail && detail.episodes.length === 0 && <Empty icon={<Compass size={30} />} title={t("discover.noEpisodes")} />}
      {detail && detail.episodes.length > 0 && (
        <div className="episodes">
          {detail.episodes.map((e) => {
            const have = localEps.has(e.number);
            return (
              <div key={e.number} className="ep" style={{ cursor: e.url ? "pointer" : "default" }} onClick={() => e.url && api.openLink(e.url).catch(fail)}>
                <div className="num">{e.number}</div>
                <div className="ethumb">
                  {e.thumbnail ? <img src={e.thumbnail} alt="" loading="lazy" /> : <div className="ph"><Play size={22} /></div>}
                  {e.url && (
                    <div className="play-over">
                      <ExternalLink size={24} />
                    </div>
                  )}
                </div>
                <div className="etext">
                  <div className="etitle">
                    <span className="t">{e.title ?? t("ep.noTitle", { n: e.number })}</span>
                  </div>
                  <div className="esub">
                    <span>{t("discover.episodeCode", { n: e.number })}</span>
                    {have && <span className="tag ok">{t("discover.haveLocal")}</span>}
                    {e.site && <span className="tag">{e.site}</span>}
                  </div>
                </div>
                <div className="eactions">
                  {e.url && (
                    <button className="btn small" onClick={(ev) => { ev.stopPropagation(); api.openLink(e.url!).catch(fail); }}>
                      <ExternalLink size={14} /> {t("link.watchOn", { p: e.site ?? hostName(e.url) })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Discover() {
  const { series } = useStore();
  const [q, setQ] = useState(() => {
    try {
      return sessionStorage.getItem(LAST_QUERY_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [results, setResults] = useState<AnimeMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AnimeMatch | null>(null);
  const libraryIds = useMemo(() => new Set(series.map((s) => s.anilistId).filter(Boolean)), [series]);

  // Suche leicht verzögert, um das Ratenlimit von AniList zu schonen
  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_QUERY_KEY, q);
    } catch {
      /* ignorieren */
    }
    if (q.trim().length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    const h = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        setResults(await api.metadataSearch(q));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    }, 600);
    return () => clearTimeout(h);
  }, [q]);

  if (selected) return <DiscoverDetailView m={selected} back={() => setSelected(null)} />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("discover.title")}</h1>
          <div className="page-sub">{t("discover.text")}</div>
        </div>
      </div>
      <div className="search-box">
        <SearchIcon size={20} />
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("discover.placeholder")} />
      </div>
      {busy && !results && <Loading />}
      {error && <Empty icon={<Compass size={30} />} title={t("meta.offline")} text={error} />}
      {!q.trim() && !error && <Empty icon={<Compass size={30} />} title={t("discover.emptyTitle")} text={t("discover.emptyText")} />}
      {results && results.length === 0 && !error && <Empty icon={<SearchIcon size={30} />} title={t("search.noResults", { q })} />}
      {results && results.length > 0 && (
        <div className="grid" style={{ opacity: busy ? 0.6 : 1, transition: "opacity .2s" }}>
          {results.map((m) => (
            <DiscoverCard key={m.anilistId} m={m} inLibrary={libraryIds.has(m.anilistId)} onOpen={() => setSelected(m)} />
          ))}
        </div>
      )}
    </div>
  );
}
