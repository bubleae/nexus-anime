import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Copy, EyeOff, FolderInput, HardDrive, Link2, MoreHorizontal, Search as SearchIcon, Trash2 } from "lucide-react";
import { api, DuplicateGroup, Episode, Series } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { episodeCode, episodeTitle, formatBytes, formatDate } from "../format";
import { Confirm, Empty, Loading, menuButton, SeriesCard } from "../components/ui";
import { useEpisodeMenu } from "../components/episodeMenu";
import { AssignDialog } from "../components/dialogs";

function useEpisodes(filter: string) {
  const { dataVersion } = useStore();
  const [list, setList] = useState<Episode[] | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api.listEpisodes(filter, 5000).then(setList).catch(() => setList([]));
  }, [filter, dataVersion, reload]);
  return [list, () => setReload((r) => r + 1)] as const;
}

const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));

function SelectableList({
  list, sel, setSel, onChanged, render,
}: {
  list: Episode[]; sel: Set<string>; setSel: (s: Set<string>) => void; onChanged: () => void; render?: (e: Episode) => React.ReactNode;
}) {
  const { openMenu } = useStore();
  const menu = useEpisodeMenu(onChanged);
  const last = useRef<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, Episode[]>();
    list.forEach((e) => {
      const d = dirOf(e.filePath);
      m.set(d, [...(m.get(d) ?? []), e]);
    });
    return [...m.entries()];
  }, [list]);
  const toggle = (e: Episode, shift: boolean) => {
    const n = new Set(sel);
    if (shift && last.current) {
      const ids = list.map((x) => x.id);
      const [a, b] = [ids.indexOf(last.current), ids.indexOf(e.id)].sort((x, y) => x - y);
      ids.slice(a, b + 1).forEach((x) => n.add(x));
    } else n.has(e.id) ? n.delete(e.id) : n.add(e.id);
    last.current = e.id;
    setSel(n);
  };
  return (
    <>
      {groups.map(([dir, eps]) => {
        const all = eps.every((e) => sel.has(e.id));
        return (
          <div key={dir}>
            <div className="group-title">
              <input
                type="checkbox"
                className="checkbox"
                checked={all}
                onChange={() => {
                  const n = new Set(sel);
                  eps.forEach((e) => (all ? n.delete(e.id) : n.add(e.id)));
                  setSel(n);
                }}
              />
              <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 600 }}>{dir}</span>
              <span>· {eps.length}</span>
            </div>
            <div className="list">
              {eps.map((e) => (
                <div
                  key={e.id}
                  className={`list-row ${sel.has(e.id) ? "selected" : ""}`}
                  onClick={(ev) => toggle(e, ev.shiftKey)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    openMenu(ev, menu(e));
                  }}
                >
                  <input type="checkbox" className="checkbox" checked={sel.has(e.id)} readOnly />
                  <div className="grow">
                    <div className="main-t">{e.fileName}</div>
                    <div className="sub-t">{render ? render(e) : formatBytes(e.fileSize)}</div>
                  </div>
                  <button className="icon-btn" onClick={menuButton(() => menu(e), openMenu)}>
                    <MoreHorizontal size={18} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function Unsorted() {
  const { openDialog, bump, toast, fail } = useStore();
  const [list, reload] = useEpisodes("unsorted");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const changed = () => {
    setSel(new Set());
    reload();
    bump();
  };
  if (!list) return <Loading />;
  const selected = list.filter((e) => sel.has(e.id));
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("unsorted.title")}</h1>
          <div className="page-sub">{t("unsorted.text")}</div>
        </div>
        {list.length > 0 && (
          <div className="btn-row">
            <button className="btn" onClick={() => setSel(sel.size === list.length ? new Set() : new Set(list.map((e) => e.id)))}>
              {t("unsorted.selectAll")}
            </button>
            <button className="btn primary" disabled={sel.size === 0} onClick={() => openDialog(<AssignDialog episodes={selected} onDone={changed} />)}>
              <Link2 size={16} /> {t("unsorted.assign")}
            </button>
          </div>
        )}
      </div>
      {list.length === 0 ? (
        <Empty icon={<CheckCircle2 size={30} />} title={t("unsorted.empty")} text={t("unsorted.emptyText")} />
      ) : (
        <SelectableList
          list={list}
          sel={sel}
          setSel={setSel}
          onChanged={changed}
          render={(e) => (
            <>
              {formatBytes(e.fileSize)}
              {e.parsedSeries && ` · ${t("unsorted.guess")}: ${e.parsedSeries}`}
              {(e.episode != null || e.season != null) && ` · ${episodeCode(e)}`}
              {e.resolution && ` · ${e.resolution}`}
            </>
          )}
        />
      )}
      {sel.size > 0 && (
        <div className="selection-bar">
          <span className="cnt">{t("common.selected", { n: sel.size })}</span>
          <button className="btn small primary" onClick={() => openDialog(<AssignDialog episodes={selected} onDone={changed} />)}>
            <Link2 size={14} /> {t("unsorted.assign")}
          </button>
          <button
            className="btn small"
            onClick={() =>
              api.hideEpisodes([...sel]).then(() => {
                toast("success", t("toast.hidden"));
                changed();
              }).catch(fail)
            }
          >
            <EyeOff size={14} /> {t("ep.hide")}
          </button>
        </div>
      )}
    </div>
  );
}

export function Unavailable() {
  const { openDialog, bump, sources } = useStore();
  const [list, reload] = useEpisodes("unavailable");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const changed = () => {
    setSel(new Set());
    reload();
    bump();
  };
  if (!list) return <Loading />;
  const offline = sources.filter((s) => !s.available && s.enabled);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("unavailable.title")}</h1>
          <div className="page-sub">{t("unavailable.text")}</div>
        </div>
        {list.length > 0 && (
          <div className="btn-row">
            <button className="btn" onClick={() => setSel(sel.size === list.length ? new Set() : new Set(list.map((e) => e.id)))}>
              {t("unsorted.selectAll")}
            </button>
            <button
              className="btn danger"
              disabled={sel.size === 0}
              onClick={() => openDialog(<Confirm title={t("unavailable.forget")} text={t("unavailable.forgetText")} danger onConfirm={async () => { await api.forgetEpisodes([...sel]); changed(); }} />)}
            >
              <Trash2 size={16} /> {t("unavailable.forget")}
            </button>
          </div>
        )}
      </div>
      {offline.map((s) => (
        <div className="banner-note warn" key={s.id}>
          <div className="ic"><HardDrive size={18} /></div>
          <div className="grow">{t("scan.offline", { p: s.path })}</div>
        </div>
      ))}
      {list.length === 0 ? (
        <Empty icon={<CheckCircle2 size={30} />} title={t("unavailable.empty")} />
      ) : (
        <SelectableList
          list={list}
          sel={sel}
          setSel={setSel}
          onChanged={changed}
          render={(e) => (
            <>
              {e.seriesTitle ? `${e.seriesTitle} · ${episodeCode(e)} · ` : ""}
              {e.missing ? t("ep.missing") : t("ep.driveOffline")}
              {e.missingSince && ` · ${t("unavailable.missingSince", { d: formatDate(e.missingSince) })}`}
            </>
          )}
        />
      )}
    </div>
  );
}

export function Duplicates() {
  const { dataVersion, openMenu, toast, fail, bump } = useStore();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [reload, setReload] = useState(0);
  const changed = () => {
    setReload((r) => r + 1);
    bump();
  };
  const menu = useEpisodeMenu(changed);
  useEffect(() => {
    api.findDuplicates().then(setGroups).catch(() => setGroups([]));
  }, [dataVersion, reload]);
  if (!groups) return <Loading />;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("dup.title")}</h1>
          <div className="page-sub">{t("dup.text")}</div>
        </div>
      </div>
      {groups.length === 0 ? (
        <Empty icon={<CheckCircle2 size={30} />} title={t("dup.empty")} />
      ) : (
        groups.map((g, i) => (
          <div key={i} style={{ marginBottom: 22 }}>
            <div className="group-title">
              {g.reason === "sameFile" ? t("dup.sameFile") : t("dup.sameEpisode")}
              {g.episodes[0].seriesTitle && <span style={{ textTransform: "none", letterSpacing: 0 }}>· {g.episodes[0].seriesTitle} · {episodeCode(g.episodes[0])}</span>}
            </div>
            <div className="list">
              {g.episodes.map((e) => (
                <div key={e.id} className="list-row" onContextMenu={(ev) => { ev.preventDefault(); openMenu(ev, menu(e)); }}>
                  <div className="grow">
                    <div className="main-t">{e.fileName}</div>
                    <div className="sub-t">{e.filePath} · {formatBytes(e.fileSize)}{e.resolution ? ` · ${e.resolution}` : ""}</div>
                  </div>
                  <button className="btn small ghost" onClick={() => api.reveal(e.id).catch(fail)} title={t("ep.reveal")}><FolderInput size={14} /></button>
                  <button className="btn small ghost" onClick={() => navigator.clipboard.writeText(e.filePath).then(() => toast("success", t("common.copied")))} title={t("ep.copyPath")}><Copy size={14} /></button>
                  <button className="btn small" onClick={() => api.hideEpisodes([e.id]).then(() => { toast("success", t("toast.hidden")); changed(); }).catch(fail)}>
                    <EyeOff size={14} /> {t("ep.hide")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function Search() {
  const { route, play, openMenu, navigate } = useStore();
  const [q, setQ] = useState(route.params?.q ?? "");
  const [res, setRes] = useState<{ series: Series[]; episodes: Episode[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const menu = useEpisodeMenu(() => setQ((x) => x));
  useEffect(() => {
    const h = setTimeout(async () => {
      if (!q.trim()) return setRes(null);
      setBusy(true);
      try {
        setRes(await api.search(q));
      } catch {
        setRes({ series: [], episodes: [] });
      } finally {
        setBusy(false);
      }
    }, 160);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="page">
      <div className="search-box">
        <SearchIcon size={20} />
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")} />
      </div>
      {!q.trim() && <div className="hint">{t("search.hint")}</div>}
      {busy && !res && <Loading />}
      {res && res.series.length === 0 && res.episodes.length === 0 && (
        <Empty icon={<SearchIcon size={30} />} title={t("search.noResults", { q })} text={t("search.hint")} />
      )}
      {res && res.series.length > 0 && (
        <>
          <h2 className="shelf-title" style={{ marginBottom: 16 }}>
            {t("search.series")} <span className="count">{res.series.length}</span>
          </h2>
          <div className="grid" style={{ marginBottom: 40 }}>
            {res.series.map((s) => <SeriesCard key={s.id} s={s} />)}
          </div>
        </>
      )}
      {res && res.episodes.length > 0 && (
        <>
          <h2 className="shelf-title" style={{ marginBottom: 16 }}>
            {t("search.episodes")} <span className="count">{res.episodes.length}</span>
          </h2>
          <div className="list">
            {res.episodes.map((e) => (
              <div
                key={e.id}
                className="list-row"
                style={{ cursor: "pointer" }}
                onClick={() => (e.seriesId ? navigate({ name: "series", params: { id: e.seriesId } }) : play(e.id))}
                onDoubleClick={() => play(e.id)}
                onContextMenu={(ev) => { ev.preventDefault(); openMenu(ev, menu(e)); }}
              >
                <span className="tag accent">{episodeCode(e)}</span>
                <div className="grow">
                  <div className="main-t">{e.seriesTitle ?? t("nav.unsorted")} · {episodeTitle(e)}</div>
                  <div className="sub-t">{e.fileName}</div>
                </div>
                {!(e.available && !e.missing) && <span className="tag warn">{t("ep.unavailable")}</span>}
                {e.watched && <span className="tag ok">{t("ep.watched")}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
