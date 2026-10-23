// Globaler App-Zustand: Einstellungen, Navigation, Toasts, Dialoge, Kontextmenü, Player.
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, Bootstrap, errorText, OpProgress, ScanProgress, Series, Settings, Source } from "./api";
import { setLanguage, t } from "./i18n";
import { emit, registerBuiltins, reloadPlugins, setAppInfo, setStoreBridge } from "./plugins/host";
import { BUILTIN_PLUGINS } from "./plugins/builtin";
import { normalizeStreamUrl, StreamSpec } from "./player/stream";

export type RouteName =
  | "home"
  | "library"
  | "continue"
  | "recentPlayed"
  | "recentAdded"
  | "favorites"
  | "unwatched"
  | "search"
  | "discover"
  | "settings"
  | "series"
  | "unsorted"
  | "unavailable"
  | "duplicates"
  | "plugin";

export type Route = { name: RouteName; params?: Record<string, string> };

export type Toast = { id: number; kind: "success" | "error" | "info"; title: string; message?: string; action?: { label: string; run: () => void } };

export type MenuItem =
  | { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }
  | { divider: true }
  | { title: string };

type Store = {
  ready: boolean;
  boot: Bootstrap | null;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  sources: Source[];
  reloadSources: () => Promise<void>;
  series: Series[];
  reloadSeries: () => Promise<void>;
  counts: { unsorted: number; unavailable: number };
  reloadCounts: () => Promise<void>;
  dataVersion: number;
  bump: () => void;
  route: Route;
  navigate: (r: Route) => void;
  back: () => void;
  canGoBack: boolean;
  toast: (kind: Toast["kind"], title: string, message?: string, action?: Toast["action"]) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  fail: (e: unknown) => void;
  dialog: ReactNode | null;
  openDialog: (node: ReactNode) => void;
  closeDialog: () => void;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  openMenu: (e: { clientX: number; clientY: number }, items: MenuItem[]) => void;
  closeMenu: () => void;
  scan: ScanProgress | null;
  metadataBusy: boolean;
  fileOp: OpProgress | null;
  clearFileOp: () => void;
  playing: string | null;
  /** Gesetzt, wenn gerade ein eigener Stream-Link läuft (dann ist `playing` "stream:…") */
  stream: StreamSpec | null;
  play: (episodeId: string) => void;
  playStream: (spec: StreamSpec) => void;
  closePlayer: () => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);

const DEFAULT_SETTINGS = {} as Settings;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [sources, setSources] = useState<Source[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [counts, setCounts] = useState({ unsorted: 0, unavailable: 0 });
  const [dataVersion, setDataVersion] = useState(0);
  const [history, setHistory] = useState<Route[]>([{ name: "home" }]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<ReactNode | null>(null);
  const [menu, setMenu] = useState<Store["menu"]>(null);
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [fileOp, setFileOp] = useState<OpProgress | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamSpec | null>(null);
  const streamSeq = useRef(0);
  const [ready, setReady] = useState(false);
  const toastId = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const route = history[history.length - 1];

  const toast = useCallback<Store["toast"]>((kind, title, message, action) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-4), { id, kind, title, message, action }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);
  const fail = useCallback((e: unknown) => {
    const msg = errorText(e);
    api.log("error", msg);
    toast("error", t("toast.error"), msg);
  }, [toast]);

  const applyLook = (s: Settings) => {
    const root = document.documentElement;
    root.dataset.theme = s.theme;
    root.dataset.accent = s.accent;
    root.dataset.animations = s.animations ? "on" : "off";
    setLanguage(s.language);
  };

  const reloadSeries = useCallback(async () => {
    try {
      setSeries(await api.listSeries());
    } catch (e) {
      fail(e);
    }
  }, [fail]);
  const reloadSources = useCallback(async () => {
    try {
      setSources(await api.listSources());
    } catch (e) {
      fail(e);
    }
  }, [fail]);
  const reloadCounts = useCallback(async () => {
    try {
      const b = await api.bootstrap();
      setCounts({ unsorted: b.unsortedCount, unavailable: b.unavailableCount });
      setSources(b.sources);
    } catch {
      /* ignorieren */
    }
  }, []);
  const bump = useCallback(() => {
    setDataVersion((v) => v + 1);
    reloadSeries();
    reloadCounts();
    emit("library:changed");
  }, [reloadSeries, reloadCounts]);

  // Start
  useEffect(() => {
    (async () => {
      try {
        const b = await api.bootstrap();
        setAppInfo({ version: b.version, dataDir: b.dataDir });
        applyLook(b.settings);
        setBoot(b);
        setSettings(b.settings);
        setSources(b.sources);
        setScan(b.scan);
        setCounts({ unsorted: b.unsortedCount, unavailable: b.unavailableCount });
        setSeries(await api.listSeries());
        let start: Route = { name: (b.settings.startPage as RouteName) || "home" };
        if (b.settings.startBehavior === "last") {
          try {
            const last = localStorage.getItem("nexus.lastRoute");
            if (last) start = JSON.parse(last);
          } catch {
            /* ignorieren */
          }
        }
        setHistory([start]);
      } catch (e) {
        fail(e);
      }
      // Plugins vor der ersten Anzeige laden (höchstens 4 s warten, damit ein langsames Plugin den Start nicht blockiert)
      registerBuiltins(BUILTIN_PLUGINS);
      await Promise.race([reloadPlugins(), new Promise((r) => setTimeout(r, 4000))]);
      setReady(true);
      emit("app:ready");
    })();
  }, []);

  // Backend-Ereignisse
  useEffect(() => {
    const unl: Promise<() => void>[] = [];
    let lastRefresh = 0;
    unl.push(
      listen<ScanProgress>("scan://progress", (e) => {
        setScan(e.payload);
        emit("scan:progress", e.payload);
        // Während großer Scans gelegentlich aktualisieren, damit neue Serien sichtbar werden
        if (e.payload.phase === "process" && Date.now() - lastRefresh > 4000) {
          lastRefresh = Date.now();
          reloadSeries();
        }
      }),
    );
    unl.push(
      listen<ScanProgress>("scan://finished", (e) => {
        setScan(e.payload);
        bump();
        emit("scan:finished", e.payload);
      }),
    );
    unl.push(listen("metadata://progress", () => setMetadataBusy(true)));
    unl.push(
      listen("metadata://updated", () => {
        reloadSeries();
        setDataVersion((v) => v + 1);
        emit("metadata:updated");
      }),
    );
    unl.push(listen("metadata://done", () => setMetadataBusy(false)));
    unl.push(listen<OpProgress>("fileops://progress", (e) => setFileOp(e.payload)));
    unl.push(
      listen<OpProgress>("fileops://finished", (e) => {
        setFileOp(e.payload);
        bump();
        emit("fileops:finished", e.payload);
      }),
    );
    return () => unl.forEach((p) => p.then((f) => f()));
  }, [bump, reloadSeries]);

  // Standard-Kontextmenü des eingebetteten Browsers unterdrücken (sonst erscheint es in Systemsprache)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", h);
    return () => document.removeEventListener("contextmenu", h);
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = { ...settingsRef.current, ...patch };
      setSettings(next);
      applyLook(next);
      try {
        const saved = await api.saveSettings(next);
        setSettings(saved);
        emit("settings:changed", { settings: saved });
        if ("libraryPath" in patch) reloadSources();
      } catch (e) {
        fail(e);
      }
    },
    [fail, reloadSources],
  );

  const navigate = useCallback((r: Route) => {
    setMenu(null);
    setHistory((h) => {
      const cur = h[h.length - 1];
      if (cur.name === r.name && JSON.stringify(cur.params) === JSON.stringify(r.params)) return h;
      return [...h.slice(-30), r];
    });
    try {
      if (r.name !== "series") localStorage.setItem("nexus.lastRoute", JSON.stringify(r));
    } catch {
      /* ignorieren */
    }
    document.querySelector(".main")?.scrollTo({ top: 0 });
  }, []);
  const back = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);

  useEffect(() => {
    if (ready) emit("route:change", { route });
  }, [route, ready]);

  const value = useMemo<Store>(
    () => ({
      ready,
      boot,
      settings,
      updateSettings,
      sources,
      reloadSources,
      series: settings.missingDriveBehavior === "hide" ? series.filter((x) => x.episodeCount === 0 || x.availableCount > 0) : series,
      reloadSeries,
      counts,
      reloadCounts,
      dataVersion,
      bump,
      route,
      navigate,
      back,
      canGoBack: history.length > 1,
      toast,
      toasts,
      dismissToast,
      fail,
      dialog,
      openDialog: (n) => setDialog(n),
      closeDialog: () => setDialog(null),
      menu,
      openMenu: (e, items) => setMenu({ x: e.clientX, y: e.clientY, items }),
      closeMenu: () => setMenu(null),
      scan,
      metadataBusy,
      fileOp,
      clearFileOp: () => setFileOp(null),
      playing,
      stream,
      play: (id) => {
        setMenu(null);
        setStream(null);
        setPlaying(id);
      },
      playStream: (spec) => {
        const url = normalizeStreamUrl(spec.url);
        setMenu(null);
        setDialog(null);
        setStream({ ...spec, url });
        setPlaying(`stream:${++streamSeq.current}`);
      },
      closePlayer: () => {
        const wasStream = stream != null;
        setPlaying(null);
        setStream(null);
        if (!wasStream) bump();
      },
    }),
    [ready, boot, settings, updateSettings, sources, reloadSources, series, reloadSeries, counts, reloadCounts, dataVersion, bump, route, navigate, back, history.length, toast, toasts, dismissToast, fail, dialog, menu, scan, metadataBusy, fileOp, playing, stream],
  );

  // Plugins greifen über diese Brücke auf den aktuellen Zustand zu
  setStoreBridge({
    settings,
    updateSettings,
    series: value.series,
    route,
    navigate,
    back,
    toast,
    openDialog: value.openDialog,
    closeDialog: value.closeDialog,
    openMenu: value.openMenu,
    play: value.play,
    playStream: value.playStream,
    closePlayer: value.closePlayer,
    bump,
  });

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
