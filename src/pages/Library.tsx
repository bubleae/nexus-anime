import { useEffect, useMemo, useState } from "react";
import { Clapperboard, History, Link as LinkIcon, Plus, Sparkles } from "lucide-react";
import { api, ContinueItem, Episode, Series } from "../api";
import { RouteName, useStore } from "../store";
import { t, TKey } from "../i18n";
import { Empty, Loading, SeriesCard } from "../components/ui";
import { EpisodeCard } from "./Home";
import { AddLinkDialog, PromptDialog } from "../components/dialogs";

type SortKey = "title" | "recentAdded" | "recentPlayed" | "episodes" | "year" | "custom";
type Filter = "all" | "watched" | "unwatched" | "started" | "favorites" | "unavailable";

const PRESETS: Partial<Record<RouteName, { title: TKey; sort: SortKey; filter: Filter }>> = {
  library: { title: "library.title", sort: "title", filter: "all" },
  favorites: { title: "nav.favorites", sort: "title", filter: "favorites" },
  recentAdded: { title: "nav.recentAdded", sort: "recentAdded", filter: "all" },
  recentPlayed: { title: "nav.recentPlayed", sort: "recentPlayed", filter: "all" },
};

export function Library() {
  const { series, route, reloadSeries, fail, navigate, openDialog } = useStore();
  const preset = PRESETS[route.name] ?? PRESETS.library!;
  const [sort, setSort] = useState<SortKey>(preset.sort);
  const [filter, setFilter] = useState<Filter>(preset.filter);
  const [genre, setGenre] = useState<string>(route.params?.genre ?? "");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => {
    setSort(preset.sort);
    setFilter(preset.filter);
    setGenre(route.params?.genre ?? "");
  }, [route.name, route.params?.genre]);

  const genres = useMemo(() => [...new Set(series.flatMap((s) => s.genres))].sort((a, b) => a.localeCompare(b, "de")), [series]);

  const list = useMemo(() => {
    let l = series.filter((s) => {
      if (genre && !s.genres.includes(genre)) return false;
      switch (filter) {
        case "watched":
          return s.episodeCount > 0 && s.watchedCount >= s.episodeCount;
        case "unwatched":
          return s.watchedCount === 0 && s.inProgressCount === 0;
        case "started":
          return (s.watchedCount > 0 || s.inProgressCount > 0) && s.watchedCount < s.episodeCount;
        case "favorites":
          return s.favorite;
        case "unavailable":
          return s.unavailableCount > 0;
        default:
          return true;
      }
    });
    if (route.name === "recentPlayed") l = l.filter((s) => s.lastPlayedAt);
    const cmp: Record<SortKey, (a: Series, b: Series) => number> = {
      title: (a, b) => a.title.localeCompare(b.title, "de", { numeric: true }),
      recentAdded: (a, b) => (b.lastAddedAt ?? b.createdAt).localeCompare(a.lastAddedAt ?? a.createdAt),
      recentPlayed: (a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""),
      episodes: (a, b) => b.episodeCount - a.episodeCount,
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
      custom: (a, b) => (a.sortIndex ?? 1e9) - (b.sortIndex ?? 1e9) || a.title.localeCompare(b.title, "de"),
    };
    return [...l].sort(cmp[sort]);
  }, [series, filter, sort, genre, route.name]);

  const drop = async (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = list.map((s) => s.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    try {
      await api.reorderSeries(ids);
      reloadSeries();
    } catch (e) {
      fail(e);
    }
  };

  const newSeries = () =>
    openDialog(
      <PromptDialog
        title={t("library.newSeries")}
        label={t("edit.name")}
        onSubmit={async (title) => {
          if (!title) return;
          const id = await api.createSeries(title);
          await reloadSeries();
          navigate({ name: "series", params: { id } });
        }}
      />,
    );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{genre ? t("home.genre", { g: genre }) : t(preset.title)}</h1>
          <div className="page-sub">{list.length === 1 ? t("library.count1") : t("library.count", { n: list.length })}</div>
        </div>
        <div className="btn-row">
          <select className="select" style={{ width: 200 }} value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">{t("library.filter.allGenres")}</option>
            {genres.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          <select className="select" style={{ width: 220 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {(["title", "recentAdded", "recentPlayed", "episodes", "year", "custom"] as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {t(`library.sort.${k}` as TKey)}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => openDialog(<AddLinkDialog onDone={async (id) => { await reloadSeries(); navigate({ name: "series", params: { id } }); }} />)}>
            <LinkIcon size={16} /> {t("link.newSeries")}
          </button>
          <button className="btn" onClick={newSeries}>
            <Plus size={16} /> {t("library.newSeries")}
          </button>
        </div>
      </div>
      <div className="chips" style={{ marginBottom: 26 }}>
        {(["all", "unwatched", "started", "watched", "favorites", "unavailable"] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {t(`library.filter.${f}` as TKey)}
          </button>
        ))}
      </div>
      {sort === "custom" && <div className="hint" style={{ marginTop: -12, marginBottom: 20 }}>{t("library.customHint")}</div>}
      {list.length === 0 ? (
        <Empty icon={<Clapperboard size={30} />} title={t("library.empty")} text={t("library.emptyText")} />
      ) : (
        <div className="grid">
          {list.map((s) => (
            <SeriesCard
              key={s.id}
              s={s}
              className={`${dragId === s.id ? "dragging" : ""} ${overId === s.id && dragId !== s.id ? "drop-before" : ""}`}
              dragProps={
                sort === "custom"
                  ? {
                      draggable: true,
                      onDragStart: (e) => {
                        setDragId(s.id);
                        e.dataTransfer.effectAllowed = "move";
                      },
                      onDragOver: (e) => {
                        e.preventDefault();
                        setOverId(s.id);
                      },
                      onDrop: (e) => {
                        e.preventDefault();
                        drop(s.id);
                        setDragId(null);
                        setOverId(null);
                      },
                      onDragEnd: () => {
                        setDragId(null);
                        setOverId(null);
                      },
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Weiterschauen bzw. ungesehene Episoden als Raster. */
export function EpisodeGrid({ kind }: { kind: "continue" | "unwatched" }) {
  const { dataVersion, series } = useStore();
  const [items, setItems] = useState<{ e: Episode; s?: Series }[] | null>(null);
  const [reload, setReload] = useState(0);
  const byId = useMemo(() => new Map(series.map((s) => [s.id, s])), [series]);
  useEffect(() => {
    if (kind === "continue") api.continueWatching(200).then((r: ContinueItem[]) => setItems(r.map((c) => ({ e: c.episode, s: c.series })))).catch(() => setItems([]));
    else api.listEpisodes("unwatched", 300).then((r) => setItems(r.map((e) => ({ e, s: e.seriesId ? byId.get(e.seriesId) : undefined })))).catch(() => setItems([]));
  }, [kind, dataVersion, reload]);
  if (!items) return <Loading />;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{kind === "continue" ? t("nav.continue") : t("nav.unwatched")}</h1>
          <div className="page-sub">{t("card.episodes", { n: items.length })}</div>
        </div>
      </div>
      {items.length === 0 ? (
        <Empty icon={kind === "continue" ? <History size={30} /> : <Sparkles size={30} />} title={t("library.empty")} text={t("library.emptyText")} />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(clamp(260px, 22vw, 340px), 1fr))" }}>
          {items.map(({ e, s }) => (
            <EpisodeCard key={e.id} e={e} series={s} onChanged={() => setReload((x) => x + 1)} />
          ))}
        </div>
      )}
    </div>
  );
}
