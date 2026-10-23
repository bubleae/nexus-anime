import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check, CheckCheck, ChevronDown, Combine, Copy, Edit3, ExternalLink, EyeOff, FilePlus2, Globe, Link as LinkIcon, FolderOpen, FolderPlus, GripVertical, Heart, ImageOff, Link2,
  ListChecks, MoreHorizontal, MoveRight, Play, RefreshCw, Search, Trash2, Undo2, X,
} from "lucide-react";
import { api, Episode, imageUrl, SeriesDetail as Detail } from "../api";
import { MenuItem, useStore } from "../store";
import { t } from "../i18n";
import { episodeCode, episodeTitle, formatBytes, formatDuration, formatMinutes, progressOf } from "../format";
import { Cover, Empty, fallbackGradient, Loading, menuButton, ProgressBar } from "../components/ui";
import { useEpisodeMenu } from "../components/episodeMenu";
import { LinkPlayDialog } from "../components/LinkPlayDialog";
import { useLinkSources } from "../player/linkSources";
import { AddLinkDialog, AssignDialog, EditSeriesDialog, FileOpsDialog, MergeSeriesDialog, MetadataDialog, PromptDialog, RemoveSeriesDialog } from "../components/dialogs";
import { requestThumbnail } from "../thumbs";
import { pluginMenuItems, usePlugins } from "../plugins/host";

type Group = { key: string; label: string; season: number | null; kind: string; episodes: Episode[] };

function groupEpisodes(eps: Episode[], names: Record<string, string>): Group[] {
  const m = new Map<string, Group>();
  for (const e of eps) {
    let key: string, label: string, season: number | null, kind: string;
    if (e.kind === "movie") {
      [key, label, season, kind] = ["movie", t("kind.movies"), null, "movie"];
    } else if (e.kind !== "episode") {
      [key, label, season, kind] = ["special", t("kind.specials"), 0, "special"];
    } else {
      const s = e.season ?? 1;
      [key, label, season, kind] = [`s${s}`, names[String(s)] ?? t("series.seasonLabel", { n: s }), s, "episode"];
    }
    if (!m.has(key)) m.set(key, { key, label, season, kind, episodes: [] });
    m.get(key)!.episodes.push(e);
  }
  const order = (g: Group) => (g.kind === "episode" ? g.season! : g.kind === "special" ? 1000 : 1001);
  const groups = [...m.values()].sort((a, b) => order(a) - order(b));
  if (groups.length === 1 && groups[0].kind === "episode" && !eps.some((e) => e.season != null && e.season !== 1)) groups[0].label = t("series.allEpisodes");
  return groups;
}

/** Nächste sinnvolle Episode: angefangene, sonst die nach der zuletzt gesehenen, sonst die erste ungesehene. */
export function nextEpisode(eps: Episode[]): Episode | null {
  const playable = eps.filter((e) => e.available && !e.missing);
  const last = [...playable].filter((e) => e.lastPlayedAt).sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""))[0];
  if (last && !last.watched) return last;
  if (last) {
    const i = playable.indexOf(last);
    const n = playable.slice(i + 1).find((e) => !e.watched);
    if (n) return n;
  }
  return playable.find((e) => !e.watched) ?? null;
}

function EpisodeRow({
  e, index, selected, selectMode, onSelect, onChanged, dragging, dropBefore, dragHandlers, genThumbs,
}: {
  e: Episode; index: number; selected: boolean; selectMode: boolean; onSelect: (shift: boolean) => void; onChanged: () => void;
  dragging: boolean; dropBefore: boolean; dragHandlers: React.HTMLAttributes<HTMLDivElement>; genThumbs: boolean;
}) {
  const { play, openMenu } = useStore();
  const menu = useEpisodeMenu(onChanged);
  const [thumb, setThumb] = useState(e.thumbnailPath);
  const playable = e.available && !e.missing;
  useEffect(() => {
    setThumb(e.thumbnailPath);
    if (!e.thumbnailPath && playable && genThumbs) {
      let alive = true;
      requestThumbnail(e.id).then((rel) => alive && rel && setThumb(rel));
      return () => {
        alive = false;
      };
    }
  }, [e.id, e.thumbnailPath, playable, genThumbs]);
  const prog = progressOf(e);
  return (
    <div
      className={`ep ${playable ? "" : "unavailable"} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${dropBefore ? "drop-before" : ""}`}
      draggable
      {...dragHandlers}
      onClick={(ev) => (selectMode || ev.ctrlKey || ev.shiftKey ? onSelect(ev.shiftKey) : play(e.id))}
      onContextMenu={(ev) => {
        ev.preventDefault();
        openMenu(ev, menu(e));
      }}
    >
      <GripVertical size={14} className="grip" />
      {selectMode ? (
        <div className="num">
          <input type="checkbox" className="checkbox" checked={selected} readOnly />
        </div>
      ) : (
        <div className="num">{e.episode ?? index + 1}</div>
      )}
      <div className="ethumb">
        {thumb ? <img src={imageUrl(thumb)!} alt="" loading="lazy" /> : <div className="ph"><Play size={22} /></div>}
        {e.duration ? <span className="dur">{formatDuration(e.duration)}</span> : null}
        {playable && (
          <div className="play-over">
            <Play size={26} fill="currentColor" />
          </div>
        )}
        {prog > 0 && prog < 1 && <ProgressBar value={prog} />}
      </div>
      <div className="etext">
        <div className="etitle">
          <span className="t">{episodeTitle(e)}</span>
          {e.watched && <Check size={16} className="watched-ic" />}
        </div>
        <div className="esub">
          <span>{episodeCode(e)}</span>
          {e.duration ? <span>{formatMinutes(e.duration)}</span> : null}
          {e.resolution && <span className="tag">{e.resolution}</span>}
          {e.version && e.version > 1 && <span className="tag">{t("ep.version", { n: e.version })}</span>}
          {[...e.audioHints, ...e.subtitleHints].slice(0, 3).map((h) => (
            <span className="tag" key={h}>{h}</span>
          ))}
          {!playable && <span className="tag warn">{e.missing ? t("ep.missing") : t("ep.driveOffline")}</span>}
          {e.watched && <span className="tag ok">{t("ep.watched")}</span>}
        </div>
        <div className="efile" title={e.filePath}>{e.fileName} · {formatBytes(e.fileSize)}</div>
      </div>
      <div className="eactions" onClick={(ev) => ev.stopPropagation()}>
        <button className="icon-btn" title={t("ep.play")} disabled={!playable} onClick={() => play(e.id)}>
          <Play size={18} />
        </button>
        <button className="icon-btn" title={t("nav.more")} onClick={menuButton(() => menu(e), openMenu)}>
          <MoreHorizontal size={18} />
        </button>
      </div>
    </div>
  );
}

export function SeriesDetail({ id }: { id: string }) {
  const { dataVersion, back, play, fail, toast, openMenu, openDialog, reloadSeries, settings, navigate } = useStore();
  const { registry } = usePlugins();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [lastSel, setLastSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<string[] | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  const [overTab, setOverTab] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const hasLinkSources = useLinkSources().some((x) => x.enabled);

  const load = () => setReload((r) => r + 1);
  useEffect(() => {
    api.seriesDetail(id).then((x) => {
      // Episoden auf nicht angeschlossenen Laufwerken ggf. ausblenden (Einstellung „Fehlende Laufwerke“)
      if (settings.missingDriveBehavior === "hide") x = { ...x, episodes: x.episodes.filter((e) => e.available || e.missing) };
      setD(x);
      setError(null);
    }).catch((e) => setError(String(e)));
  }, [id, dataVersion, reload, settings.missingDriveBehavior]);
  useEffect(() => {
    setTab(null);
    setSel(new Set());
    setSelectMode(false);
  }, [id]);

  const groups = useMemo(() => (d ? groupEpisodes(d.episodes, d.seasonNames) : []), [d]);
  const next = useMemo(() => (d ? nextEpisode(d.episodes) : null), [d]);
  useEffect(() => {
    if (groups.length && (!tab || !groups.some((g) => g.key === tab))) {
      const g = next ? groups.find((g) => g.episodes.some((e) => e.id === next.id)) : null;
      setTab((g ?? groups[0]).key);
    }
  }, [groups]);

  if (error) return <Empty icon={<ImageOff size={30} />} title={t("toast.error")} text={error}><button className="btn" onClick={back}>{t("common.back")}</button></Empty>;
  if (!d) return <Loading />;

  const s = d.series;
  const current = groups.find((g) => g.key === tab) ?? groups[0];
  const banner = imageUrl(s.bannerPath, s.updatedAt);
  const cover = imageUrl(s.coverPath, s.updatedAt);
  const unwatched = s.episodeCount - s.watchedCount;
  const started = s.watchedCount > 0 || s.inProgressCount > 0;
  const firstPlayable = d.episodes.find((e) => e.available && !e.missing);

  const act = (p: Promise<unknown>, ok?: string) => p.then(() => { if (ok) toast("success", ok); load(); reloadSeries(); }).catch(fail);

  const VIDEO_EXT = ["mp4", "mkv", "avi", "mov", "webm", "m4v", "wmv", "ts", "m2ts", "mpg", "mpeg", "flv"];
  const addToSeries = async (folder: boolean) => {
    const picked = folder
      ? await open({ directory: true, multiple: true })
      : await open({ multiple: true, filters: [{ name: "Videos", extensions: VIDEO_EXT }] });
    if (!picked) return;
    try {
      const r = await api.addFiles(Array.isArray(picked) ? picked : [picked], s.id);
      toast("success", t("series.added", { n: r.added + r.skipped }), s.title);
      load();
      reloadSeries();
    } catch (e) {
      fail(e);
    }
  };
  const addMenu = (): MenuItem[] => [
    { label: t("series.addFiles"), icon: <FilePlus2 size={16} />, onClick: () => addToSeries(false) },
    { label: t("series.addFolder"), icon: <FolderPlus size={16} />, onClick: () => addToSeries(true) },
  ];

  const openLink = (url: string) => api.openLink(url).catch(fail);
  const primaryLink = d.links[0] ?? null;
  // Fehlende Folgen: Gesamtzahl laut AniList minus vorhandene Episodennummern
  const haveNumbers = new Set(d.episodes.filter((e) => e.kind === "episode" && e.episode != null).map((e) => `${e.season ?? 1}:${e.episode}`));
  const missingCount = s.totalEpisodes && s.seasonCount <= 1 ? Math.max(0, s.totalEpisodes - haveNumbers.size) : 0;

  const seriesMenu = (): MenuItem[] => [
    { label: t("link.add"), icon: <LinkIcon size={16} />, onClick: () => openDialog(<AddLinkDialog seriesId={s.id} onDone={load} />) },
    { label: t("series.addEpisodes"), icon: <FilePlus2 size={16} />, onClick: () => addToSeries(false) },
    { label: t("series.edit"), icon: <Edit3 size={16} />, onClick: () => openDialog(<EditSeriesDialog s={s} onDone={load} />) },
    { label: t("series.metadata"), icon: <Search size={16} />, onClick: () => openDialog(<MetadataDialog s={s} onDone={load} />) },
    { label: t("series.refreshMetadata"), icon: <RefreshCw size={16} />, onClick: () => act(api.metadataRefresh([s.id], true), t("meta.loading")) },
    { divider: true },
    { label: t("series.markAllWatched"), icon: <CheckCheck size={16} />, onClick: () => act(api.markSeriesWatched(s.id, true)) },
    { label: t("series.markAllUnwatched"), icon: <Undo2 size={16} />, onClick: () => act(api.markSeriesWatched(s.id, false)) },
    ...((): MenuItem[] => {
      const extra = pluginMenuItems(registry.seriesMenu, s);
      return extra.length ? [{ divider: true }, ...extra] : [];
    })(),
    { divider: true },
    { label: t("series.organize"), icon: <MoveRight size={16} />, onClick: () => openDialog(<FileOpsDialog request={{ seriesIds: [s.id], mode: settings.fileMode === "move" ? "move" : "copy" }} />) },
    { label: t("series.merge"), icon: <Combine size={16} />, onClick: () => openDialog(<MergeSeriesDialog s={s} onDone={(tid) => { reloadSeries(); navigate({ name: "series", params: { id: tid } }); }} />) },
    { label: t("series.remove"), icon: <Trash2 size={16} />, danger: true, onClick: () => openDialog(<RemoveSeriesDialog s={s} onDone={() => { reloadSeries(); back(); }} />) },
  ];

  const toggleSel = (e: Episode, shift: boolean) => {
    setSelectMode(true);
    setSel((prev) => {
      const n = new Set(prev);
      if (shift && lastSel && current) {
        const ids = current.episodes.map((x) => x.id);
        const [a, b] = [ids.indexOf(lastSel), ids.indexOf(e.id)].sort((x, y) => x - y);
        ids.slice(a, b + 1).forEach((x) => n.add(x));
      } else n.has(e.id) ? n.delete(e.id) : n.add(e.id);
      return n;
    });
    setLastSel(e.id);
  };
  const selectedEps = d.episodes.filter((e) => sel.has(e.id));
  const clearSel = () => { setSel(new Set()); setSelectMode(false); };

  const dropOnTab = async (g: Group) => {
    if (!drag) return;
    await act(api.moveEpisodesToSeason(drag, g.kind === "episode" ? g.season : g.kind === "special" ? 0 : null, g.kind), t("toast.moved"));
    setDrag(null);
    setOverTab(null);
  };
  const dropOnRow = async (target: Episode) => {
    if (!drag || !current) return;
    const ids = current.episodes.map((e) => e.id);
    if (drag.some((x) => !ids.includes(x))) return;
    const rest = ids.filter((x) => !drag.includes(x));
    rest.splice(rest.indexOf(target.id) < 0 ? rest.length : rest.indexOf(target.id), 0, ...drag);
    await act(api.reorderEpisodes(rest));
    setDrag(null);
    setOverRow(null);
  };

  const moveSelectedMenu = (): MenuItem[] => [
    ...groups.filter((g) => g.kind === "episode").map((g) => ({ label: g.label, onClick: () => act(api.moveEpisodesToSeason([...sel], g.season, "episode"), t("toast.moved")) })),
    { label: t("common.season") + " …", onClick: () => openDialog(<PromptDialog title={t("assign.season")} label={t("common.season")} initial={String((groups.filter((g) => g.kind === "episode").pop()?.season ?? 0) + 1)} onSubmit={(v) => act(api.moveEpisodesToSeason([...sel], Number(v) || 1, "episode"), t("toast.moved"))} />) },
    { divider: true },
    { label: t("kind.specials"), onClick: () => act(api.moveEpisodesToSeason([...sel], 0, "special"), t("toast.moved")) },
    { label: t("kind.movies"), onClick: () => act(api.moveEpisodesToSeason([...sel], null, "movie"), t("toast.moved")) },
  ];

  return (
    <div className="page flush">
      <div className="detail-hero">
        {banner ? (
          <div className="hero-bg" style={{ backgroundImage: `url("${banner}")` }} />
        ) : cover ? (
          <div className="hero-bg blurred" style={{ backgroundImage: `url("${cover}")` }} />
        ) : (
          <div className="hero-bg" style={{ background: fallbackGradient(s.title) }} />
        )}
        <div className="detail-head">
          <div className="detail-cover">
            <Cover path={s.coverPath} title={s.title} version={s.updatedAt} />
          </div>
          <div className="detail-info">
            <h1 className="detail-title">{s.title}</h1>
            {s.altTitle && s.altTitle.toLowerCase() !== s.title.toLowerCase() && <div className="detail-alt">{s.altTitle}</div>}
            <div className="detail-meta">
              {s.year && <span className="tag">{s.year}</span>}
              {s.format && <span className="tag">{s.format}</span>}
              {s.score && <span className="tag accent">★ {s.score} %</span>}
              {s.studio && <span className="tag">{s.studio}</span>}
              {s.genres.map((g) => (
                <span key={g} className="tag" style={{ cursor: "pointer" }} onClick={() => navigate({ name: "library", params: { genre: g } })}>{g}</span>
              ))}
              {s.unavailableCount > 0 && <span className="tag warn">{t("card.unavailable", { n: s.unavailableCount })}</span>}
            </div>
            {s.description ? (
              <>
                <p className={`detail-desc ${expanded ? "" : "clamped"}`}>{s.description}</p>
                {s.description.length > 320 && (
                  <button className="more-link" onClick={() => setExpanded(!expanded)}>{expanded ? "−" : "+"} {t("nav.more")}</button>
                )}
              </>
            ) : (
              <p className="detail-desc" style={{ color: "var(--text-3)" }}>{t("series.noDescription")}</p>
            )}
            <div className="stats">
              <div className="stat"><div className="v">{s.episodeCount}</div><div className="l">{t("common.episodes")}</div></div>
              <div className="stat"><div className="v">{Math.max(1, s.seasonCount)}</div><div className="l">{t("common.seasons")}</div></div>
              <div className="stat"><div className="v">{s.watchedCount}</div><div className="l">{t("ep.watched")}</div></div>
              <div className="stat"><div className="v">{unwatched}</div><div className="l">{t("series.unwatched", { n: "" }).trim()}</div></div>
              {missingCount > 0 && (
                <div className="stat" title={t("link.ofTotal", { n: haveNumbers.size, t: s.totalEpisodes ?? 0 })}>
                  <div className="v" style={{ color: "var(--warning)" }}>{missingCount}</div>
                  <div className="l">{t("link.missing")}</div>
                </div>
              )}
            </div>
            {started && (
              <div className="detail-progress">
                <div className="hint" style={{ marginBottom: 6 }}>{t("series.watched", { w: s.watchedCount, n: s.episodeCount })}</div>
                <ProgressBar value={s.episodeCount ? s.watchedCount / s.episodeCount : 0} large />
              </div>
            )}
            <div className="btn-row">
              {started && next ? (
                <button className="btn white large" onClick={() => play(next.id)}>
                  <Play size={19} fill="currentColor" /> {t("series.continueEp", { ep: episodeCode(next) })}
                </button>
              ) : null}
              {!firstPlayable && primaryLink ? (
                <button className="btn white large" onClick={() => openLink(primaryLink.url)}>
                  <ExternalLink size={19} /> {t("link.watchOn", { p: primaryLink.providerName })}
                </button>
              ) : (
                <button className={`btn ${started && next ? "glass" : "white"} large`} disabled={!firstPlayable} onClick={() => firstPlayable && play(firstPlayable.id)}>
                  <Play size={19} fill={started && next ? "none" : "currentColor"} /> {t("series.play")}
                </button>
              )}
              {hasLinkSources && (
                <button className="btn glass large" onClick={() => openDialog(<LinkPlayDialog series={s} episodes={d.episodes} />)}>
                  <Globe size={18} /> {t("links.button")}
                </button>
              )}
              <button className="btn glass round large" title={s.favorite ? t("series.unfavorite") : t("series.addFavorite")}
                onClick={() => act(api.setFavorite(s.id, !s.favorite), s.favorite ? t("toast.favoriteOff") : t("toast.favoriteOn"))}>
                <Heart size={19} fill={s.favorite ? "#ff5c8a" : "none"} color={s.favorite ? "#ff5c8a" : "currentColor"} />
              </button>
              <button className="btn glass large" onClick={menuButton(addMenu, openMenu)}>
                <FilePlus2 size={18} /> {t("series.addEpisodes")}
              </button>
              <button className="btn glass large" disabled={d.episodes.length === 0} onClick={() => api.openSeriesFolder(s.id).catch(fail)}>
                <FolderOpen size={18} /> {t("series.openFolder")}
              </button>
              <button className="btn glass round large" title={t("nav.more")} onClick={menuButton(seriesMenu, openMenu)}>
                <MoreHorizontal size={19} />
              </button>
            </div>
            <div className="watch-links">
              <span className="wl-label">{t("link.whereToWatch")}</span>
              {d.links.map((l) => (
                <button
                  key={l.id}
                  className={`provider-chip p-${l.provider}`}
                  title={l.source === "anilist" ? `${l.url}
${t("link.auto")}` : l.url}
                  onClick={() => openLink(l.url)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    openMenu(ev, [
                      { label: t("link.watchOn", { p: l.providerName }), icon: <ExternalLink size={16} />, onClick: () => openLink(l.url) },
                      { label: t("link.copy"), icon: <Copy size={16} />, onClick: () => navigator.clipboard.writeText(l.url).then(() => toast("success", t("common.copied"))) },
                      { label: t("link.remove"), icon: <Trash2 size={16} />, danger: true, onClick: () => act(api.removeSeriesLink(l.id)) },
                    ]);
                  }}
                >
                  <span className="dot" /> {l.providerName} <ExternalLink size={13} />
                </button>
              ))}
              <button className="provider-chip add" onClick={() => openDialog(<AddLinkDialog seriesId={s.id} onDone={load} />)}>
                + {t("link.add")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {d.episodes.length === 0 ? (
        <Empty icon={<ImageOff size={30} />} title={t("series.noEpisodes")} text={t("series.emptyHint")}>
          <div className="btn-row" style={{ justifyContent: "center" }}>
            <button className="btn primary" onClick={() => addToSeries(false)}><FilePlus2 size={16} /> {t("series.addFiles")}</button>
            <button className="btn" onClick={() => addToSeries(true)}><FolderPlus size={16} /> {t("series.addFolder")}</button>
          </div>
        </Empty>
      ) : (
        <>
          <div className="tabs">
            {groups.map((g) => (
              <button
                key={g.key}
                className={`tab ${current?.key === g.key ? "active" : ""} ${overTab === g.key ? "drop-target" : ""}`}
                onClick={() => setTab(g.key)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  if (g.kind !== "episode") return;
                  openMenu(ev, [{ label: t("series.renameSeason"), icon: <Edit3 size={16} />, onClick: () => openDialog(<PromptDialog title={t("series.renameSeason")} initial={d.seasonNames[String(g.season)] ?? ""} onSubmit={(v) => act(api.setSeasonName(s.id, g.season!, v || null))} />) }]);
                }}
                onDragOver={(ev) => { if (drag && g.key !== current?.key) { ev.preventDefault(); setOverTab(g.key); } }}
                onDragLeave={() => setOverTab(null)}
                onDrop={(ev) => { ev.preventDefault(); dropOnTab(g); }}
              >
                {g.label}
                <span className="n">{g.episodes.length}</span>
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button className={`btn small ${selectMode ? "primary" : "ghost"}`} style={{ alignSelf: "center" }} onClick={() => (selectMode ? clearSel() : setSelectMode(true))}>
              <ListChecks size={15} /> {t("series.selectMode")}
            </button>
          </div>
          <div className="hint" style={{ marginBottom: 12 }}>{t("series.dragHint")}</div>
          <div className="episodes">
            {current?.episodes.map((e, i) => (
              <EpisodeRow
                key={e.id}
                e={e}
                index={i}
                selected={sel.has(e.id)}
                selectMode={selectMode}
                onSelect={(shift) => toggleSel(e, shift)}
                onChanged={() => { load(); reloadSeries(); }}
                dragging={!!drag?.includes(e.id)}
                dropBefore={overRow === e.id && !drag?.includes(e.id)}
                genThumbs={settings.generateThumbnails}
                dragHandlers={{
                  onDragStart: (ev) => {
                    const ids = sel.has(e.id) ? [...sel] : [e.id];
                    setDrag(ids);
                    ev.dataTransfer.effectAllowed = "move";
                    ev.dataTransfer.setData("text/plain", ids.join(","));
                  },
                  onDragOver: (ev) => { if (drag) { ev.preventDefault(); setOverRow(e.id); } },
                  onDrop: (ev) => { ev.preventDefault(); dropOnRow(e); },
                  onDragEnd: () => { setDrag(null); setOverRow(null); setOverTab(null); },
                }}
              />
            ))}
          </div>
        </>
      )}

      {sel.size > 0 && (
        <div className="selection-bar">
          <span className="cnt">{t("common.selected", { n: sel.size })}</span>
          <button className="btn small" onClick={() => act(api.markWatched([...sel], true)).then(clearSel)}><Check size={14} /> {t("ep.markWatched")}</button>
          <button className="btn small" onClick={() => act(api.markWatched([...sel], false)).then(clearSel)}><Undo2 size={14} /></button>
          <button className="btn small" onClick={menuButton(moveSelectedMenu, openMenu)}><MoveRight size={14} /> {t("common.season")} <ChevronDown size={13} /></button>
          <button className="btn small" onClick={() => openDialog(<AssignDialog episodes={selectedEps} defaultSeriesId={s.id} onDone={() => { clearSel(); load(); reloadSeries(); }} />)}><Link2 size={14} /> {t("unsorted.assign")}</button>
          <button className="btn small" onClick={() => navigator.clipboard.writeText(selectedEps.map((e) => e.filePath).join("\r\n")).then(() => toast("success", t("common.copied")))}><Copy size={14} /></button>
          <button className="btn small" title={t("ep.hide")} onClick={() => act(api.hideEpisodes([...sel]), t("toast.hidden")).then(clearSel)}><EyeOff size={14} /></button>
          <button className="icon-btn" onClick={clearSel}><X size={16} /></button>
        </div>
      )}
    </div>
  );
}
