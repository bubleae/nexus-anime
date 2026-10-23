import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArrowRight, Check, Copy, FolderInput, ImagePlus, RotateCcw, Search } from "lucide-react";
import { AnimeMatch, api, Episode, EpisodeKind, FileProperties, LinkInfo, Plan, PlannedOp, Series } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { episodeCode, formatBytes, formatDate, formatDuration } from "../format";
import { Cover, Modal, Switch } from "./ui";

const KINDS: EpisodeKind[] = ["episode", "special", "ova", "movie", "extra"];
const numOrNull = (v: string) => (v.trim() === "" ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// ---------------------------------------------------------------------------
export function PropertiesDialog({ episode }: { episode: Episode }) {
  const { closeDialog, toast } = useStore();
  const [p, setP] = useState<FileProperties | null>(null);
  useEffect(() => {
    api.fileProperties(episode.id).then(setP).catch(() => setP(null));
  }, [episode.id]);
  const copy = () => {
    navigator.clipboard.writeText(episode.filePath);
    toast("success", t("common.copied"));
  };
  return (
    <Modal
      title={t("props.title")}
      subtitle={episode.seriesTitle ? `${episode.seriesTitle} · ${episodeCode(episode)}` : undefined}
      onClose={closeDialog}
      size="wide"
      footer={
        <>
          <div className="left">
            <button className="btn small" onClick={copy}>
              <Copy size={14} /> {t("ep.copyPath")}
            </button>
            <button className="btn small" onClick={() => api.reveal(episode.id).catch((e) => toast("error", t("toast.error"), String(e)))}>
              <FolderInput size={14} /> {t("ep.reveal")}
            </button>
          </div>
          <button className="btn primary" onClick={closeDialog}>
            {t("common.close")}
          </button>
        </>
      }
    >
      {p && !p.exists && (
        <div className="banner-note warn" style={{ marginBottom: 18 }}>
          <div className="ic">
            <AlertTriangle size={18} />
          </div>
          {t("props.notFound")}
        </div>
      )}
      <div className="kv">
        <div className="k">{t("props.name")}</div>
        <div className="v">{episode.fileName}</div>
        <div className="k">{t("props.location")}</div>
        <div className="v">{p?.folder ?? episode.filePath}</div>
        <div className="k">{t("props.size")}</div>
        <div className="v">{formatBytes(p?.size ?? episode.fileSize)}</div>
        <div className="k">{t("props.format")}</div>
        <div className="v">
          {p?.format ?? "–"} <span className="hint">({p?.mime})</span>
        </div>
        <div className="k">{t("props.duration")}</div>
        <div className="v">{formatDuration(episode.duration ?? p?.containerDuration ?? null)}</div>
        {episode.resolution && (
          <>
            <div className="k">{t("props.resolution")}</div>
            <div className="v">{episode.resolution}</div>
          </>
        )}
        {episode.audioHints.length > 0 && (
          <>
            <div className="k">{t("props.audio")}</div>
            <div className="v">{episode.audioHints.join(", ")}</div>
          </>
        )}
        {episode.subtitleHints.length > 0 && (
          <>
            <div className="k">{t("props.subs")}</div>
            <div className="v">{episode.subtitleHints.join(", ")}</div>
          </>
        )}
        <div className="k">{t("props.created")}</div>
        <div className="v">{p?.created ?? "–"}</div>
        <div className="k">{t("props.modified")}</div>
        <div className="v">{p?.modified ?? "–"}</div>
        <div className="k">{t("props.added")}</div>
        <div className="v">{formatDate(episode.addedAt)}</div>
        <div className="k">{t("props.recognized")}</div>
        <div className="v">
          {episode.parsedSeries ?? "–"} · {episodeCode(episode)}
          {episode.version ? ` · ${t("ep.version", { n: episode.version })}` : ""}
        </div>
        <div className="k">{t("props.confidence")}</div>
        <div className="v">{episode.manual ? t("props.manual") : `${Math.round(episode.confidence * 100)} %`}</div>
        {p?.originPath && (
          <>
            <div className="k">{t("props.origin")}</div>
            <div className="v">{p.originPath}</div>
          </>
        )}
      </div>
      {p && p.tracks.length > 0 && (
        <>
          <div className="group-title">{t("props.tracks")}</div>
          <div className="list">
            {p.tracks.map((tr, i) => (
              <div className="list-row" key={i}>
                <span className="tag">{tr.kind}</span>
                <div className="grow">
                  <div className="main-t">
                    {tr.codec} {tr.name ? `· ${tr.name}` : ""}
                  </div>
                  <div className="sub-t">{[tr.language, tr.detail].filter(Boolean).join(" · ")}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function EditEpisodeDialog({ episode, onDone }: { episode: Episode; onDone: () => void }) {
  const { closeDialog, fail, toast } = useStore();
  const [season, setSeason] = useState(episode.season?.toString() ?? "");
  const [ep, setEp] = useState(episode.episode?.toString() ?? "");
  const [epEnd, setEpEnd] = useState(episode.episodeEnd?.toString() ?? "");
  const [title, setTitle] = useState(episode.title ?? "");
  const [kind, setKind] = useState<EpisodeKind>(episode.kind);
  const [version, setVersion] = useState(episode.version?.toString() ?? "");
  const save = async () => {
    try {
      await api.updateEpisode(episode.id, {
        season: numOrNull(season),
        episode: numOrNull(ep),
        episodeEnd: numOrNull(epEnd),
        title: title.trim() || null,
        kind,
        version: numOrNull(version),
      });
      toast("success", t("toast.saved"));
      closeDialog();
      onDone();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={t("ep.editTitle")}
      subtitle={episode.fileName}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={save}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("ep.fieldTitle")}</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && save()} />
      </div>
      <div className="row">
        <div className="field">
          <label>{t("ep.fieldSeason")}</label>
          <input className="input" type="number" min={0} value={season} onChange={(e) => setSeason(e.target.value)} />
        </div>
        <div className="field">
          <label>{t("ep.fieldEpisode")}</label>
          <input className="input" type="number" min={0} value={ep} onChange={(e) => setEp(e.target.value)} />
        </div>
        <div className="field">
          <label>{t("ep.fieldEpisodeEnd")}</label>
          <input className="input" type="number" min={0} value={epEnd} onChange={(e) => setEpEnd(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>{t("ep.fieldKind")}</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as EpisodeKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t("ep.fieldVersion")}</label>
          <input className="input" type="number" min={1} value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function DeleteFileDialog({ episode, onDone }: { episode: Episode; onDone: () => void }) {
  const { closeDialog, fail, toast } = useStore();
  const [typed, setTyped] = useState("");
  const ok = typed === episode.fileName;
  return (
    <Modal
      title={t("ep.deleteTitle")}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button
            className="btn danger"
            disabled={!ok}
            onClick={async () => {
              try {
                await api.deleteEpisodeFile(episode.id, typed);
                toast("success", t("toast.deleted"), episode.fileName);
                closeDialog();
                onDone();
              } catch (e) {
                fail(e);
              }
            }}
          >
            {t("ep.deleteConfirm")}
          </button>
        </>
      }
    >
      <p style={{ color: "var(--text-2)", marginTop: 0 }}>{t("ep.deleteText")}</p>
      <div className="tag danger" style={{ height: "auto", padding: "6px 10px", marginBottom: 12, userSelect: "text", whiteSpace: "normal" }}>
        {episode.fileName}
      </div>
      <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={episode.fileName} autoFocus />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function SeriesPicker({ value, onChange, exclude }: { value: string | null; onChange: (id: string) => void; exclude?: string }) {
  const { series } = useStore();
  const [q, setQ] = useState("");
  const list = useMemo(
    () =>
      series
        .filter((s) => s.id !== exclude)
        .filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()) || s.altTitle?.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 200),
    [series, q, exclude],
  );
  return (
    <div>
      <div style={{ position: "relative" }}>
        <Search size={16} style={{ position: "absolute", left: 13, top: 12, color: "var(--text-3)" }} />
        <input className="input" style={{ paddingLeft: 38 }} placeholder={t("assign.searchSeries")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pick-list">
        {list.map((s) => (
          <div key={s.id} className={`pick-item ${value === s.id ? "active" : ""}`} onClick={() => onChange(s.id)}>
            <div className="mini-cover">
              <Cover path={s.coverPath} title={s.title} version={s.updatedAt} />
            </div>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{s.title}</div>
              <div className="hint">
                {s.episodeCount === 1 ? t("card.episode1") : t("card.episodes", { n: s.episodeCount })}
                {s.year ? ` · ${s.year}` : ""}
              </div>
            </div>
            {value === s.id && <Check size={18} color="var(--accent-2)" />}
          </div>
        ))}
        {list.length === 0 && <div className="hint" style={{ padding: 14 }}>{t("library.empty")}</div>}
      </div>
    </div>
  );
}

export function AssignDialog({ episodes, onDone, defaultSeriesId }: { episodes: Episode[]; onDone: () => void; defaultSeriesId?: string }) {
  const { closeDialog, fail, toast, series } = useStore();
  const [mode, setMode] = useState<"existing" | "new">(series.length && defaultSeriesId !== undefined ? "existing" : series.length ? "existing" : "new");
  const [seriesId, setSeriesId] = useState<string | null>(defaultSeriesId ?? null);
  const guess = episodes.find((e) => e.parsedSeries)?.parsedSeries ?? "";
  const [newTitle, setNewTitle] = useState(guess);
  const [keepSeason, setKeepSeason] = useState(true);
  const [season, setSeason] = useState("1");
  const [renumber, setRenumber] = useState(false);
  const [start, setStart] = useState("1");
  const [kind, setKind] = useState<string>("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const sorted = useMemo(() => [...episodes].sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true })), [episodes]);

  const submit = async () => {
    setBusy(true);
    try {
      const sid = await api.assignEpisodes({
        episodeIds: sorted.map((e) => e.id),
        seriesId: mode === "existing" ? seriesId : null,
        newSeriesTitle: mode === "new" ? newTitle : null,
        season: keepSeason ? null : numOrNull(season),
        startEpisode: renumber ? numOrNull(start) : null,
        kind: kind || null,
        rememberFolders: remember,
      });
      toast("success", t("assign.done", { n: episodes.length }));
      closeDialog();
      onDone();
      return sid;
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const valid = mode === "existing" ? !!seriesId : newTitle.trim().length > 0;
  return (
    <Modal
      title={t("assign.title")}
      subtitle={t("assign.count", { n: episodes.length })}
      onClose={closeDialog}
      size="wide"
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={submit}>
            {t("common.apply")}
          </button>
        </>
      }
    >
      <div className="chips" style={{ marginBottom: 14 }}>
        <button className={`chip ${mode === "existing" ? "active" : ""}`} onClick={() => setMode("existing")}>
          {t("assign.existing")}
        </button>
        <button className={`chip ${mode === "new" ? "active" : ""}`} onClick={() => setMode("new")}>
          {t("assign.new")}
        </button>
      </div>
      {mode === "existing" ? (
        <SeriesPicker value={seriesId} onChange={setSeriesId} />
      ) : (
        <div className="field">
          <input className="input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t("assign.newPlaceholder")} autoFocus />
        </div>
      )}
      <div className="row" style={{ marginTop: 18, alignItems: "flex-start" }}>
        <div className="field">
          <label>{t("assign.season")}</label>
          <label className="row hint" style={{ gap: 8 }}>
            <input type="checkbox" className="checkbox" checked={keepSeason} onChange={(e) => setKeepSeason(e.target.checked)} />
            {t("assign.keepSeason")}
          </label>
          {!keepSeason && <input className="input" type="number" min={0} value={season} onChange={(e) => setSeason(e.target.value)} />}
        </div>
        <div className="field">
          <label>{t("assign.startEpisode")}</label>
          <label className="row hint" style={{ gap: 8 }}>
            <input type="checkbox" className="checkbox" checked={!renumber} onChange={(e) => setRenumber(!e.target.checked)} />
            {t("assign.keepEpisodes")}
          </label>
          {renumber && (
            <div className="row">
              <span className="hint">{t("assign.renumber")}</span>
              <input className="input" type="number" min={0} value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
          )}
        </div>
        <div className="field">
          <label>{t("assign.kind")}</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t("assign.keepKind")}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="row" style={{ gap: 10, margin: "4px 0 16px", color: "var(--text-2)", fontSize: 13 }}>
        <input type="checkbox" className="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {t("assign.remember")}
      </label>
      <div className="label" style={{ marginBottom: 6 }}>
        {t("assign.preview")}
      </div>
      <div className="list" style={{ maxHeight: 220, overflowY: "auto" }}>
        {sorted.map((e, i) => {
          const n = renumber ? (numOrNull(start) ?? 1) + i : e.episode;
          const s = keepSeason ? e.season : numOrNull(season);
          return (
            <div className="list-row" key={e.id} style={{ padding: "8px 14px" }}>
              <div className="grow sub-t">{e.fileName}</div>
              <ArrowRight size={14} color="var(--text-3)" />
              <span className="tag accent">{episodeCode({ ...e, episode: n, season: s, kind: (kind || e.kind) as EpisodeKind })}</span>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function EditSeriesDialog({ s, onDone }: { s: Series; onDone: () => void }) {
  const { closeDialog, fail, toast, reloadSeries } = useStore();
  const [title, setTitle] = useState(s.title);
  const [alt, setAlt] = useState(s.altTitle ?? "");
  const [desc, setDesc] = useState(s.description ?? "");
  const [year, setYear] = useState(s.year?.toString() ?? "");
  const [genres, setGenres] = useState(s.genres.join(", "));
  const [locked, setLocked] = useState(s.metadataLocked);
  const [cover, setCover] = useState(s.coverPath);
  const [banner, setBanner] = useState(s.bannerPath);
  const [ver, setVer] = useState(s.updatedAt);

  const pickImage = async (kind: "cover" | "banner") => {
    const file = await open({ multiple: false, filters: [{ name: "Bilder", extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif"] }] });
    if (!file || Array.isArray(file)) return;
    try {
      const rel = await api.setSeriesImage(s.id, kind, file);
      kind === "cover" ? setCover(rel) : setBanner(rel);
      setVer(String(Date.now()));
    } catch (e) {
      fail(e);
    }
  };
  const resetImage = async (kind: "cover" | "banner") => {
    try {
      await api.resetSeriesImage(s.id, kind);
      kind === "cover" ? setCover(null) : setBanner(null);
    } catch (e) {
      fail(e);
    }
  };
  const save = async () => {
    try {
      await api.updateSeries(s.id, {
        title,
        altTitle: alt.trim() || null,
        description: desc.trim() || null,
        year: numOrNull(year),
        genres: genres.split(",").map((g) => g.trim()).filter(Boolean),
        metadataLocked: locked,
      });
      toast("success", t("toast.saved"));
      closeDialog();
      reloadSeries();
      onDone();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={t("edit.title")}
      onClose={() => {
        closeDialog();
        onDone();
      }}
      size="wide"
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={save}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 24 }}>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            {t("edit.cover")}
          </div>
          <Cover path={cover} title={title} version={ver} />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => pickImage("cover")}>
              <ImagePlus size={14} /> {t("edit.import")}
            </button>
            {cover && (
              <button className="btn small ghost" onClick={() => resetImage("cover")} title={t("edit.reset")}>
                <RotateCcw size={14} />
              </button>
            )}
          </div>
          <div className="label" style={{ margin: "18px 0 6px" }}>
            {t("edit.banner")}
          </div>
          <div style={{ aspectRatio: "16/9", borderRadius: 10, overflow: "hidden", background: "var(--surface-2)" }}>
            {banner && <img src={`http://nexus.localhost/img/${banner}?v=${ver}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => pickImage("banner")}>
              <ImagePlus size={14} /> {t("edit.import")}
            </button>
            {banner && (
              <button className="btn small ghost" onClick={() => resetImage("banner")} title={t("edit.reset")}>
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        </div>
        <div>
          <div className="field">
            <label>{t("edit.name")}</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>{t("edit.alt")}</label>
            <input className="input" value={alt} onChange={(e) => setAlt(e.target.value)} />
          </div>
          <div className="row">
            <div className="field" style={{ maxWidth: 140 }}>
              <label>{t("edit.year")}</label>
              <input className="input" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
            </div>
            <div className="field">
              <label>{t("edit.genres")}</label>
              <input className="input" value={genres} onChange={(e) => setGenres(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>{t("edit.description")}</label>
            <textarea className="textarea" rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <label className="row" style={{ gap: 12, color: "var(--text-2)" }}>
            <Switch checked={locked} onChange={setLocked} />
            {t("edit.lock")}
          </label>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function MetadataDialog({ s, onDone }: { s: Series; onDone: () => void }) {
  const { closeDialog, fail, toast, reloadSeries } = useStore();
  const [q, setQ] = useState(s.title);
  const [results, setResults] = useState<AnimeMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<AnimeMatch | null>(null);
  const [rename, setRename] = useState(true);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.metadataSearch(q);
      setResults(r);
      setSel(r.find((x) => x.anilistId === s.anilistId) ?? r[0] ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    run();
  }, []);
  const apply = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await api.metadataApply(s.id, sel, rename);
      toast("success", t("meta.applied"));
      closeDialog();
      reloadSeries();
      onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("meta.title")}
      subtitle={t("meta.text")}
      onClose={closeDialog}
      size="xwide"
      footer={
        <>
          <div className="left">
            <label className="row" style={{ gap: 10, color: "var(--text-2)", fontSize: 13 }}>
              <Switch checked={rename} onChange={setRename} />
              {t("meta.rename")}
            </label>
          </div>
          <button
            className="btn ghost"
            onClick={async () => {
              try {
                await api.metadataClear(s.id);
                closeDialog();
                reloadSeries();
                onDone();
              } catch (e) {
                fail(e);
              }
            }}
          >
            {t("meta.clear")}
          </button>
          <button className="btn primary" disabled={!sel || busy} onClick={apply}>
            {t("meta.apply")}
          </button>
        </>
      }
    >
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("meta.placeholder")} autoFocus />
        <button className="btn primary" disabled={busy}>
          <Search size={16} /> {t("common.search")}
        </button>
      </form>
      {busy && !results && (
        <div className="center" style={{ padding: 50 }}>
          <div className="spinner lg" />
        </div>
      )}
      {error && (
        <div className="banner-note warn" style={{ marginTop: 16 }}>
          <div className="ic">
            <AlertTriangle size={18} />
          </div>
          <div>
            <b>{t("meta.offline")}</b>
            <div className="hint">{error}</div>
          </div>
        </div>
      )}
      {results && results.length === 0 && <div className="empty">{t("meta.none")}</div>}
      {results && results.length > 0 && (
        <div className="meta-results">
          {results.map((r) => (
            <div key={r.anilistId} className={`meta-item ${sel?.anilistId === r.anilistId ? "active" : ""}`} onClick={() => setSel(r)} onDoubleClick={apply}>
              <img src={r.coverLarge ?? r.coverMedium ?? ""} alt="" />
              <div className="t">{r.titleRomaji ?? r.titleEnglish}</div>
              <div className="s">
                {[r.format, r.year, r.episodes ? t("meta.episodes", { n: r.episodes }) : null].filter(Boolean).join(" · ")}
              </div>
              {r.titleEnglish && r.titleEnglish !== r.titleRomaji && <div className="s">{r.titleEnglish}</div>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function FileOpsDialog({ request }: { request: { seriesIds?: string[]; episodeIds?: string[]; mode: "copy" | "move"; onlyOutside?: boolean } }) {
  const { closeDialog, fail } = useStore();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.planFileOperation(request).then(setPlan).catch((e) => setError(String(e)));
  }, []);
  const runnable = (o: PlannedOp) => (o.status === "ok" || o.status === "duplicate" || (o.status === "exists" && plan?.conflictPolicy === "rename")) && !excluded.has(o.episodeId);
  const selected = plan?.ops.filter(runnable) ?? [];
  const size = selected.reduce((a, o) => a + o.size, 0);
  const statusTag = (s: PlannedOp["status"]) => {
    const cls = s === "ok" ? "ok" : s === "duplicate" ? "accent" : s === "same" ? "" : "warn";
    return <span className={`tag ${cls}`}>{t(`fileops.status.${s}`)}</span>;
  };
  return (
    <Modal
      title={t(`fileops.title.${request.mode}`)}
      subtitle={t("fileops.text")}
      onClose={closeDialog}
      size="xwide"
      footer={
        <>
          <div className="left hint">{plan && t("fileops.count", { n: selected.length, size: formatBytes(size) })}</div>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!plan || selected.length === 0}
            onClick={async () => {
              try {
                await api.executeFileOperation(request.mode, selected);
                closeDialog();
              } catch (e) {
                fail(e);
              }
            }}
          >
            {t(`fileops.execute.${request.mode}`, { n: selected.length })}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-note warn">
          <div className="ic">
            <AlertTriangle size={18} />
          </div>
          {error}
        </div>
      )}
      {!plan && !error && (
        <div className="center" style={{ padding: 50 }}>
          <div className="spinner lg" />
        </div>
      )}
      {plan && (
        <>
          <div className="hint" style={{ marginBottom: 6 }}>
            {t("fileops.target", { p: plan.libraryPath })}
          </div>
          <div className="hint" style={{ marginBottom: 14 }}>
            {plan.conflictPolicy === "rename" ? t("fileops.conflictRename") : t("fileops.conflictSkip")}
            {request.mode === "move" && <> {t("fileops.moveWarning")}</>}
          </div>
          <div className="list" style={{ maxHeight: "48vh", overflowY: "auto" }}>
            {plan.ops.map((o) => (
              <div className="list-row" key={o.episodeId} style={{ alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  className="checkbox"
                  style={{ marginTop: 3 }}
                  disabled={!(o.status === "ok" || o.status === "duplicate" || (o.status === "exists" && plan.conflictPolicy === "rename"))}
                  checked={runnable(o)}
                  onChange={(e) =>
                    setExcluded((x) => {
                      const n = new Set(x);
                      e.target.checked ? n.delete(o.episodeId) : n.add(o.episodeId);
                      return n;
                    })
                  }
                />
                <div className="grow">
                  <div className="sub-t" title={o.from}>
                    {t("fileops.from")}: {o.from}
                  </div>
                  <div className="main-t" style={{ fontWeight: 500, fontSize: 13 }} title={o.to}>
                    {t("fileops.to")}: {o.to || "–"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {statusTag(o.status)}
                  <div className="hint">{formatBytes(o.size)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function RemoveSeriesDialog({ s, onDone }: { s: Series; onDone: () => void }) {
  const { closeDialog, fail } = useStore();
  const [mode, setMode] = useState<"unsort" | "hide">("unsort");
  return (
    <Modal
      title={t("series.removeTitle")}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              try {
                await api.removeSeries(s.id, mode);
                closeDialog();
                onDone();
              } catch (e) {
                fail(e);
              }
            }}
          >
            {t("common.remove")}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--text-2)" }}>{t("series.removeText", { t: s.title })}</p>
      {(["unsort", "hide"] as const).map((m) => (
        <label key={m} className={`radio-card ${mode === m ? "active" : ""}`}>
          <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
          <div>{m === "unsort" ? t("series.removeUnsort") : t("series.removeHide")}</div>
        </label>
      ))}
    </Modal>
  );
}

export function MergeSeriesDialog({ s, onDone }: { s: Series; onDone: (targetId: string) => void }) {
  const { closeDialog, fail } = useStore();
  const [target, setTarget] = useState<string | null>(null);
  return (
    <Modal
      title={t("series.mergeTitle")}
      subtitle={t("series.mergeText", { t: s.title })}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!target}
            onClick={async () => {
              try {
                await api.mergeSeries(s.id, target!);
                closeDialog();
                onDone(target!);
              } catch (e) {
                fail(e);
              }
            }}
          >
            {t("common.apply")}
          </button>
        </>
      }
    >
      <SeriesPicker value={target} onChange={setTarget} exclude={s.id} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
/** Eigener Eingabedialog statt window.prompt (der würde in der Windows-Systemsprache erscheinen). */
export function PromptDialog({ title, label, initial, onSubmit }: { title: string; label?: string; initial?: string; onSubmit: (value: string) => Promise<void> | void }) {
  const { closeDialog, fail } = useStore();
  const [v, setV] = useState(initial ?? "");
  const submit = async () => {
    try {
      await onSubmit(v.trim());
      closeDialog();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={title}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={submit}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="field">
        {label && <label>{label}</label>}
        <input className="input" value={v} onChange={(e) => setV(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && submit()} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
/** Link zu einem offiziellen Anbieter hinzufügen – für eine bestehende Serie oder als neue Online-Serie. */
export function AddLinkDialog({ seriesId, onDone }: { seriesId?: string; onDone: (seriesId: string) => void }) {
  const { closeDialog, fail, toast } = useStore();
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setInfo(null);
    setError(null);
    if (!url.trim()) return;
    const h = setTimeout(() => {
      api.inspectLink(url)
        .then((r) => {
          setInfo(r);
          if (!title && r.title) setTitle(r.title);
        })
        .catch((e) => setError(String(e)));
    }, 250);
    return () => clearTimeout(h);
  }, [url]);
  const submit = async () => {
    if (!info) return;
    setBusy(true);
    try {
      let id = seriesId;
      if (id) await api.addSeriesLink(id, info.url);
      else id = await api.createSeriesFromLink(info.url, title);
      toast("success", t("link.added"), info.providerName);
      closeDialog();
      onDone(id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={seriesId ? t("link.addTitle") : t("link.newSeriesTitle")}
      subtitle={seriesId ? t("link.addText") : t("link.newSeriesText")}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!info || busy || (!seriesId && !title.trim())} onClick={submit}>
            {seriesId ? t("common.save") : t("link.create")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Link</label>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("link.placeholder")} autoFocus onKeyDown={(e) => e.key === "Enter" && submit()} />
        {info && <span className="tag ok" style={{ alignSelf: "flex-start" }}>{t("link.detected", { p: info.providerName })}</span>}
        {error && <span className="hint" style={{ color: "var(--danger)", whiteSpace: "pre-line" }}>{error}</span>}
        {!info && !error && <span className="hint">{t("link.supported")}</span>}
      </div>
      {!seriesId && (
        <div className="field">
          <label>{t("edit.name")}</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
      )}
    </Modal>
  );
}
