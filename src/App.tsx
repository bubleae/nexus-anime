import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Copy as CopyIcon, FolderDown, Inbox, Layers, Minus, RefreshCw, Search, Settings, Square, X,
} from "lucide-react";
import { api } from "./api";
import { RouteName, useStore } from "./store";
import { t, TKey } from "./i18n";
import { ContextMenu, Loading, menuButton, ProgressBar, Toasts } from "./components/ui";
import { Home } from "./pages/Home";
import { EpisodeGrid, Library } from "./pages/Library";
import { SeriesDetail } from "./pages/SeriesDetail";
import { Duplicates, Search as SearchPage, Unavailable, Unsorted } from "./pages/Manage";
import { SettingsPage } from "./pages/Settings";
import { Discover } from "./pages/Discover";
import { Player } from "./player/Player";
import { PluginPage } from "./pages/Plugins";
import { handlePluginShortcut, iconNode, usePlugins } from "./plugins/host";

function TitleBar() {
  const win = getCurrentWindow();
  const [max, setMax] = useState(false);
  useEffect(() => {
    win.isMaximized().then(setMax);
    const un = win.onResized(() => win.isMaximized().then(setMax));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return (
    <div className="titlebar">
      <div className="drag" data-tauri-drag-region onDoubleClick={() => win.toggleMaximize()}>
        NEXUS ANIME
      </div>
      <button className="win-btn" title="Minimieren" onClick={() => win.minimize()}><Minus size={16} /></button>
      <button className="win-btn" title={max ? "Verkleinern" : "Maximieren"} onClick={() => win.toggleMaximize()}>
        {max ? <CopyIcon size={13} /> : <Square size={13} />}
      </button>
      <button className="win-btn close" title="Schließen" onClick={() => win.close()}><X size={17} /></button>
    </div>
  );
}

const NAV: { name: RouteName; label: TKey; long?: boolean }[] = [
  { name: "home", label: "nav.home" },
  { name: "library", label: "nav.library" },
  { name: "continue", label: "nav.continue", long: true },
  { name: "recentPlayed", label: "nav.recentPlayed", long: true },
  { name: "recentAdded", label: "nav.recentAdded", long: true },
  { name: "favorites", label: "nav.favorites" },
  { name: "discover", label: "nav.discover" },
  { name: "unwatched", label: "nav.unwatched", long: true },
];

function TopNav() {
  const { route, navigate, back, canGoBack, counts, scan, openMenu, fail, toast } = useStore();
  const scanning = !!scan?.running;
  const { registry } = usePlugins();
  const isPluginPage = (pluginId: string, id: string) => route.name === "plugin" && route.params?.plugin === pluginId && route.params?.page === id;
  const topPages = registry.pages.filter((p) => p.nav === "top");
  const morePages = registry.pages.filter((p) => p.nav === "more");
  return (
    <nav className="topnav">
      {canGoBack && route.name !== "home" && (
        <button className="icon-btn" onClick={back} title={t("common.back")} style={{ marginRight: 6 }}><ArrowLeft size={19} /></button>
      )}
      <div className="logo" onClick={() => navigate({ name: "home" })}>
        <div className="logo-mark">N</div>
        <span>NEXUS <b>ANIME</b></span>
      </div>
      <div className="nav-links">
        {NAV.map((n) => (
          <button key={n.name} className={`nav-link ${route.name === n.name ? "active" : ""}`} onClick={() => navigate({ name: n.name })}>
            <span className={n.long ? "lbl-long" : ""}>{t(n.label)}</span>
          </button>
        ))}
        {topPages.map((p) => (
          <button key={p.uid} className={`nav-link ${isPluginPage(p.pluginId, p.id) ? "active" : ""}`} onClick={() => navigate({ name: "plugin", params: { plugin: p.pluginId, page: p.id } })}>
            {p.title}
          </button>
        ))}
        <button
          className={`nav-link ${["unsorted", "unavailable", "duplicates"].includes(route.name) || morePages.some((p) => isPluginPage(p.pluginId, p.id)) ? "active" : ""}`}
          onClick={menuButton(
            () => [
              { label: t("nav.continue"), onClick: () => navigate({ name: "continue" }) },
              { label: t("nav.recentPlayed"), onClick: () => navigate({ name: "recentPlayed" }) },
              { label: t("nav.recentAdded"), onClick: () => navigate({ name: "recentAdded" }) },
              { label: t("nav.unwatched"), onClick: () => navigate({ name: "unwatched" }) },
              { divider: true },
              { label: `${t("nav.unsorted")}${counts.unsorted ? ` (${counts.unsorted})` : ""}`, icon: <Inbox size={16} />, onClick: () => navigate({ name: "unsorted" }) },
              { label: `${t("nav.unavailable")}${counts.unavailable ? ` (${counts.unavailable})` : ""}`, icon: <AlertTriangle size={16} />, onClick: () => navigate({ name: "unavailable" }) },
              { label: t("nav.duplicates"), icon: <Layers size={16} />, onClick: () => navigate({ name: "duplicates" }) },
              ...(morePages.length
                ? [
                    { divider: true as const },
                    ...morePages.map((p) => ({ label: p.title, icon: iconNode(p.icon), onClick: () => navigate({ name: "plugin", params: { plugin: p.pluginId, page: p.id } }) })),
                  ]
                : []),
            ],
            openMenu,
          )}
        >
          {t("nav.more")}
          {counts.unsorted > 0 && <span className="count">{counts.unsorted}</span>}
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="nav-right">
        <button className={`icon-btn ${route.name === "search" ? "active" : ""}`} title={t("nav.search")} onClick={() => navigate({ name: "search" })}><Search size={19} /></button>
        <button
          className={`icon-btn ${scanning ? "spin" : ""}`}
          title={t("scan.start")}
          onClick={() => (scanning ? api.cancelScan() : api.startScan().then(() => toast("info", t("toast.scanStarted")))).catch(fail)}
        >
          <RefreshCw size={18} />
        </button>
        <button className={`icon-btn ${route.name === "settings" ? "active" : ""}`} title={t("nav.settings")} onClick={() => navigate({ name: "settings" })}><Settings size={19} /></button>
      </div>
    </nav>
  );
}

function ScanCard() {
  const { scan, navigate } = useStore();
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    if (!scan || scan.running) return;
    const id = setTimeout(() => setHidden(scan.startedAt), 9000);
    return () => clearTimeout(id);
  }, [scan?.running, scan?.startedAt]);
  if (!scan || hidden === scan.startedAt) return null;
  if (!scan.running && scan.trigger !== "manual" && scan.added === 0 && scan.missing === 0 && scan.moved === 0 && scan.errors.length === 0) return null;
  const phaseText = scan.running ? t(`scan.${scan.phase}` as TKey) : scan.cancelled ? t("scan.cancelled") : scan.phase === "error" ? t("scan.error") : t("scan.done");
  return (
    <div className="scan-card">
      <div className="head">
        {scan.running ? <div className="spinner" /> : scan.phase === "error" ? <AlertTriangle size={20} color="var(--danger)" /> : <CheckCircle2 size={20} color="var(--success)" />}
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{scan.running ? t("scan.scanning") : phaseText}</div>
          <div className="hint">{scan.running ? phaseText : t("scan.found", { n: scan.filesFound })}</div>
        </div>
        {scan.running ? (
          <button className="btn small" onClick={() => api.cancelScan()}>{t("scan.cancel")}</button>
        ) : (
          <button className="icon-btn" onClick={() => setHidden(scan.startedAt)}><X size={16} /></button>
        )}
      </div>
      {scan.running && (
        <div className={`progress ${scan.phase === "discover" ? "indeterminate" : ""}`}>
          <div style={{ width: scan.phase === "discover" ? undefined : `${scan.filesFound ? (scan.processed / scan.filesFound) * 100 : 0}%` }} />
        </div>
      )}
      <div className="nums">
        {scan.running && <>{t("scan.found", { n: scan.filesFound })} · </>}
        {t("scan.summary", { added: scan.added, moved: scan.moved, missing: scan.missing, unsorted: scan.unsorted })}
        {scan.errors.length > 0 && <span style={{ color: "var(--danger)" }}> · {t("scan.errors", { n: scan.errors.length })}</span>}
      </div>
      {scan.unavailableSources.map((p) => <div key={p} className="hint" style={{ color: "var(--warning)" }}>{t("scan.offline", { p })}</div>)}
      {scan.running && scan.currentPath && <div className="path">{scan.currentPath}</div>}
      {!scan.running && scan.unsorted > 0 && (
        <button className="btn small primary" style={{ marginTop: 10 }} onClick={() => navigate({ name: "unsorted" })}>{t("home.unsortedAction")}</button>
      )}
    </div>
  );
}

function FileOpCard() {
  const { fileOp, clearFileOp } = useStore();
  if (!fileOp) return null;
  return (
    <div className="scan-card" style={{ bottom: 24, left: "auto", right: 24 }}>
      <div className="head">
        {fileOp.running ? <div className="spinner" /> : <CheckCircle2 size={20} color="var(--success)" />}
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{fileOp.running ? t("fileops.running") : t("common.done")}</div>
          <div className="hint">{t("fileops.finished", { done: fileOp.done, skipped: fileOp.skipped, failed: fileOp.failed.length })}</div>
        </div>
        {!fileOp.running && <button className="icon-btn" onClick={clearFileOp}><X size={16} /></button>}
      </div>
      {fileOp.running && <ProgressBar value={fileOp.total ? (fileOp.done + fileOp.skipped + fileOp.failed.length) / fileOp.total : 0} />}
      {fileOp.current && <div className="path">{fileOp.current}</div>}
      {fileOp.backup && !fileOp.running && <div className="hint" style={{ marginTop: 6 }}>{t("fileops.backup")}</div>}
      {fileOp.failed.slice(0, 4).map((f) => <div key={f} className="hint" style={{ color: "var(--danger)", wordBreak: "break-all" }}>{f}</div>)}
    </div>
  );
}

function useExplorerDrop() {
  const { toast, fail, playing, route, series } = useStore();
  // Auf einer Serienseite abgelegte Dateien direkt dieser Serie zuordnen
  const targetSeries = route.name === "series" ? series.find((x) => x.id === route.params?.id) ?? null : null;
  const [over, setOver] = useState(false);
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      if (playing) return;
      if (e.payload.type === "over" || e.payload.type === "enter") setOver(true);
      else if (e.payload.type === "leave") setOver(false);
      else if (e.payload.type === "drop") {
        setOver(false);
        try {
          const r = await api.addFiles(e.payload.paths, targetSeries?.id);
          if (targetSeries) toast("success", t("series.added", { n: r.added + r.skipped }), targetSeries.title);
          else toast(r.added ? "success" : "info", r.added ? t("drop.added", { n: r.added }) : t("drop.none"));
        } catch (err) {
          fail(err);
        }
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [playing, targetSeries?.id]);
  return { over, targetSeries };
}

function Page() {
  const { route } = useStore();
  switch (route.name) {
    case "home":
      return <Home />;
    case "library":
    case "favorites":
    case "recentAdded":
    case "recentPlayed":
      return <Library />;
    case "continue":
      return <EpisodeGrid kind="continue" />;
    case "unwatched":
      return <EpisodeGrid kind="unwatched" />;
    case "series":
      return <SeriesDetail id={route.params!.id} />;
    case "search":
      return <SearchPage />;
    case "discover":
      return <Discover />;
    case "settings":
      return <SettingsPage />;
    case "unsorted":
      return <Unsorted />;
    case "unavailable":
      return <Unavailable />;
    case "duplicates":
      return <Duplicates />;
    case "plugin": {
      const { plugin = "", page = "", ...params } = route.params ?? {};
      return <PluginPage plugin={plugin} page={page} params={params} />;
    }
  }
}

export default function App() {
  const { ready, dialog, playing, route, settings } = useStore();
  const { over: dropping, targetSeries: dropSeries } = useExplorerDrop();
  // Globale Kurzbefehle: Strg+F = Suche
  const { navigate } = useStore();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (playing) return;
      if (handlePluginShortcut(e, false)) return;
      if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !(e.target as HTMLElement).closest("input, textarea"))) {
        e.preventDefault();
        navigate({ name: "search" });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [playing, navigate]);

  return (
    <div className="app" key={settings.language}>
      <TitleBar />
      {!ready ? (
        <Loading />
      ) : (
        <>
          <TopNav />
          <main className="main">
            <Page key={route.name === "series" ? `series-${route.params?.id}` : route.name === "plugin" ? `plugin-${route.params?.plugin}-${route.params?.page}` : route.name} />
          </main>
          <ScanCard />
          <FileOpCard />
        </>
      )}
      {playing && <Player key={playing} episodeId={playing} />}
      {dialog}
      <ContextMenu />
      <Toasts />
      {dropping && (
        <div className="drop-overlay">
          <div className="drop-box">
            <FolderDown size={48} color="var(--accent-2)" />
            <h2>{t("drop.title")}</h2>
            <div className="hint">{dropSeries ? t("drop.textSeries", { t: dropSeries.title }) : t("drop.text")}</div>
          </div>
        </div>
      )}
    </div>
  );
}
