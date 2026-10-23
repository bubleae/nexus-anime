import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FilePlus2, FolderPlus, HardDrive, Info, Library, Play, RefreshCw, Sparkles } from "lucide-react";
import { api, ContinueItem, Episode, imageUrl, Series } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { episodeCode, episodeTitle, formatDuration, progressOf } from "../format";
import { Cover, fallbackGradient, Loading, ProgressBar, SeriesCard, Shelf } from "../components/ui";
import { PluginView, usePlugins } from "../plugins/host";
import { useEpisodeMenu } from "../components/episodeMenu";
import { FileOpsDialog } from "../components/dialogs";

export function EpisodeCard({ e, series, onChanged, sub }: { e: Episode; series?: Series; onChanged: () => void; sub?: string }) {
  const { play, navigate, openMenu } = useStore();
  const menu = useEpisodeMenu(onChanged);
  const img = imageUrl(e.thumbnailPath) ?? imageUrl(series?.bannerPath, series?.updatedAt) ?? imageUrl(series?.coverPath, series?.updatedAt);
  const playable = e.available && !e.missing;
  const remaining = e.duration && e.position ? e.duration - e.position : null;
  return (
    <div
      className="wcard wide"
      onClick={() => (playable ? play(e.id) : e.seriesId && navigate({ name: "series", params: { id: e.seriesId } }))}
      onContextMenu={(ev) => {
        ev.preventDefault();
        openMenu(ev, menu(e));
      }}
    >
      <div className="thumb" style={!img ? { background: fallbackGradient(e.seriesTitle ?? e.fileName) } : undefined}>
        {img && <img src={img} alt="" loading="lazy" />}
        {playable && (
          <div className="play-bubble">
            <Play size={22} fill="currentColor" />
          </div>
        )}
        <div className="info">
          <div className="code">
            {episodeCode(e)}
            {!playable && ` · ${t("ep.unavailable")}`}
          </div>
          <div className="t">{episodeTitle(e)}</div>
          {progressOf(e) > 0 && progressOf(e) < 1 && <ProgressBar value={progressOf(e)} />}
        </div>
      </div>
      <div className="sub">
        {sub ?? e.seriesTitle}
        {remaining ? ` · ${t("ep.remaining", { t: formatDuration(remaining) })}` : ""}
      </div>
    </div>
  );
}

export function Welcome() {
  const { fail, toast, scan, reloadSources } = useStore();
  const addFolder = async () => {
    const dir = await open({ directory: true, multiple: true });
    if (!dir) return;
    for (const d of Array.isArray(dir) ? dir : [dir]) {
      try {
        await api.addSource(d, true);
      } catch (e) {
        fail(e);
      }
    }
    reloadSources();
    toast("info", t("toast.sourceAdded"));
  };
  const addFiles = async () => {
    const files = await open({ multiple: true, filters: [{ name: "Videos", extensions: ["mp4", "mkv", "avi", "mov", "webm", "m4v", "wmv", "ts"] }] });
    if (!files) return;
    try {
      const r = await api.addFiles(Array.isArray(files) ? files : [files]);
      toast("success", t("drop.added", { n: r.added }));
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="logo-mark welcome-logo">N</div>
        <h1>
          {t("welcome.title").replace("NEXUS ANIME", "")}
          <span>NEXUS ANIME</span>
        </h1>
        <p className="lead">{t("welcome.text")}</p>
        {scan?.running ? (
          <div className="center" style={{ gap: 14 }}>
            <div className="spinner lg" />
            <div style={{ color: "var(--text-2)" }}>{t("welcome.scanning")}</div>
            <div className="hint">{t("scan.found", { n: scan.filesFound })}</div>
          </div>
        ) : (
          <div className="btn-row" style={{ justifyContent: "center" }}>
            <button className="btn primary large" onClick={addFolder}>
              <FolderPlus size={19} /> {t("welcome.addFolder")}
            </button>
            <button className="btn large" onClick={addFiles}>
              <FilePlus2 size={19} /> {t("welcome.addFiles")}
            </button>
          </div>
        )}
        <p className="hint" style={{ marginTop: 18 }}>
          {t("welcome.hint")}
        </p>
        <div className="steps">
          {[
            [t("welcome.step1"), t("welcome.step1Text")],
            [t("welcome.step2"), t("welcome.step2Text")],
            [t("welcome.step3"), t("welcome.step3Text")],
          ].map(([h, p], i) => (
            <div className="step" key={i}>
              <div className="n">{i + 1}</div>
              <h4>{h}</h4>
              <p>{p}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Hero({ item, s }: { item: ContinueItem | null; s: Series }) {
  const { play, navigate } = useStore();
  const banner = imageUrl(s.bannerPath, s.updatedAt);
  const cover = imageUrl(s.coverPath, s.updatedAt);
  const ep = item?.episode;
  return (
    <div className="hero">
      {banner ? (
        <div className="hero-bg" style={{ backgroundImage: `url("${banner}")` }} />
      ) : cover ? (
        <div className="hero-bg blurred" style={{ backgroundImage: `url("${cover}")` }} />
      ) : (
        <div className="hero-bg" style={{ background: fallbackGradient(s.title) }} />
      )}
      <div className="hero-content">
        <div className="hero-cover">
          <Cover path={s.coverPath} title={s.title} version={s.updatedAt} />
        </div>
        <div>
          <div className="hero-eyebrow">{ep ? t("home.continue") : t("home.recentAdded")}</div>
          <h1 className="hero-title">{s.title}</h1>
          <div className="hero-meta">
            {s.year && <span>{s.year}</span>}
            <span>{s.episodeCount === 1 ? t("card.episode1") : t("card.episodes", { n: s.episodeCount })}</span>
            {s.genres.slice(0, 3).map((g) => (
              <span className="tag" key={g}>
                {g}
              </span>
            ))}
          </div>
          {ep ? (
            <div className="hero-progress">
              <div className="lbl">
                {episodeCode(ep)} · {episodeTitle(ep)}
              </div>
              <ProgressBar value={progressOf(ep)} large />
            </div>
          ) : (
            s.description && <p className="hero-desc">{s.description}</p>
          )}
          <div className="btn-row">
            {ep && (
              <button className="btn white large" onClick={() => play(ep.id)}>
                <Play size={19} fill="currentColor" /> {t("home.heroContinue")}
              </button>
            )}
            <button className={`btn ${ep ? "glass" : "white"} large`} onClick={() => navigate({ name: "series", params: { id: s.id } })}>
              <Info size={19} /> {t("home.heroDetails")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Home() {
  const { series, dataVersion, navigate, counts, settings, openDialog, sources, scan } = useStore();
  const { registry } = usePlugins();
  const pluginSections = (pos: "top" | "bottom") =>
    registry.homeSections
      .filter((x) => (x.position ?? "bottom") === pos)
      .map((x) => (
        <div key={x.uid} className="home-plugin">
          {x.title && <h2 className="shelf-title-plain">{x.title}</h2>}
          <PluginView pluginId={x.pluginId} spec={x} ctx={{ series }} />
        </div>
      ));
  const [cont, setCont] = useState<ContinueItem[] | null>(null);
  const [unwatched, setUnwatched] = useState<Episode[]>([]);
  const [outside, setOutside] = useState(0);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((r) => r + 1);

  useEffect(() => {
    api.continueWatching(20).then(setCont).catch(() => setCont([]));
    api.listEpisodes("unwatched", 30).then(setUnwatched).catch(() => {});
    if (settings.fileMode !== "reference" && settings.libraryPath) api.countOutsideLibrary().then(setOutside).catch(() => {});
    else setOutside(0);
  }, [dataVersion, reload, settings.fileMode, settings.libraryPath]);

  const byId = useMemo(() => new Map(series.map((s) => [s.id, s])), [series]);
  const recentAdded = useMemo(() => [...series].filter((s) => s.lastAddedAt).sort((a, b) => (b.lastAddedAt ?? "").localeCompare(a.lastAddedAt ?? "")).slice(0, 20), [series]);
  const recentPlayed = useMemo(() => [...series].filter((s) => s.lastPlayedAt).sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? "")).slice(0, 20), [series]);
  const favorites = useMemo(() => series.filter((s) => s.favorite), [series]);
  const unavailable = useMemo(() => series.filter((s) => s.unavailableCount > 0), [series]);
  const all = useMemo(() => [...series].sort((a, b) => a.title.localeCompare(b.title, "de")), [series]);
  const genres = useMemo(() => {
    const m = new Map<string, Series[]>();
    series.forEach((s) => s.genres.forEach((g) => m.set(g, [...(m.get(g) ?? []), s])));
    return [...m.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  }, [series]);

  if (cont === null) return <Loading />;
  if (series.length === 0 && (sources.length === 0 || scan?.running || counts.unsorted === 0)) return <Welcome />;

  const heroItem = cont[0] ?? null;
  const heroSeries = heroItem?.series ?? recentAdded.find((s) => s.bannerPath) ?? recentAdded[0] ?? all[0];

  return (
    <div className="page flush">
      {heroSeries && <Hero item={heroItem} s={byId.get(heroSeries.id) ?? heroSeries} />}

      {pluginSections("top")}
      {counts.unsorted > 0 && (
        <div className="banner-note">
          <div className="ic">
            <Sparkles size={18} />
          </div>
          <div className="grow">{t("home.unsortedBanner", { n: counts.unsorted })}</div>
          <button className="btn small primary" onClick={() => navigate({ name: "unsorted" })}>
            {t("home.unsortedAction")}
          </button>
        </div>
      )}
      {outside > 0 && (
        <div className="banner-note">
          <div className="ic">
            <Library size={18} />
          </div>
          <div className="grow">{t("home.libraryBanner", { n: outside })}</div>
          <button
            className="btn small"
            onClick={() => openDialog(<FileOpsDialog request={{ mode: settings.fileMode === "move" ? "move" : "copy", onlyOutside: true }} />)}
          >
            {t("home.libraryAction")}
          </button>
        </div>
      )}
      {sources.some((s) => !s.available && s.enabled) && (
        <div className="banner-note warn">
          <div className="ic">
            <HardDrive size={18} />
          </div>
          <div className="grow">
            {sources
              .filter((s) => !s.available && s.enabled)
              .map((s) => t("scan.offline", { p: s.path }))
              .join(" · ")}
          </div>
          <button className="btn small" onClick={() => api.startScan()}>
            <RefreshCw size={14} /> {t("scan.start")}
          </button>
        </div>
      )}

      {cont.length > 0 && (
        <Shelf title={t("home.continue")} count={cont.length} onMore={() => navigate({ name: "continue" })}>
          {cont.map((c) => (
            <EpisodeCard key={c.episode.id} e={c.episode} series={c.series} onChanged={refresh} />
          ))}
        </Shelf>
      )}
      {recentAdded.length > 0 && (
        <Shelf title={t("home.recentAdded")} onMore={() => navigate({ name: "recentAdded" })}>
          {recentAdded.map((s) => (
            <SeriesCard key={s.id} s={s} />
          ))}
        </Shelf>
      )}
      {favorites.length > 0 && (
        <Shelf title={t("home.favorites")} count={favorites.length} onMore={() => navigate({ name: "favorites" })}>
          {favorites.map((s) => (
            <SeriesCard key={s.id} s={s} />
          ))}
        </Shelf>
      )}
      {recentPlayed.length > 0 && (
        <Shelf title={t("home.recentPlayed")} onMore={() => navigate({ name: "recentPlayed" })}>
          {recentPlayed.map((s) => (
            <SeriesCard key={s.id} s={s} />
          ))}
        </Shelf>
      )}
      {unwatched.length > 0 && (
        <Shelf title={t("home.unwatched")} onMore={() => navigate({ name: "unwatched" })}>
          {unwatched.map((e) => (
            <EpisodeCard key={e.id} e={e} series={e.seriesId ? byId.get(e.seriesId) : undefined} onChanged={refresh} />
          ))}
        </Shelf>
      )}
      {genres.map(([g, list]) => (
        <Shelf key={g} title={t("home.genre", { g })} count={list.length} onMore={() => navigate({ name: "library", params: { genre: g } })}>
          {list.map((s) => (
            <SeriesCard key={s.id} s={s} />
          ))}
        </Shelf>
      ))}
      <Shelf title={t("home.all")} count={all.length} onMore={() => navigate({ name: "library" })}>
        {all.slice(0, 40).map((s) => (
          <SeriesCard key={s.id} s={s} />
        ))}
      </Shelf>
      {unavailable.length > 0 && (
        <Shelf title={t("home.unavailable")} count={unavailable.length} onMore={() => navigate({ name: "unavailable" })}>
          {unavailable.map((s) => (
            <SeriesCard key={s.id} s={s} />
          ))}
        </Shelf>
      )}
      {pluginSections("bottom")}
      {series.length === 0 && counts.unsorted > 0 && (
        <div className="banner-note warn">
          <div className="ic">
            <AlertTriangle size={18} />
          </div>
          {t("home.unsortedBanner", { n: counts.unsorted })}
        </div>
      )}
    </div>
  );
}
