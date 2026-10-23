// Plugin-Host: lädt eingebaute und installierte Plugins, stellt ihnen die `nexus`-API bereit
// und verwaltet alle Erweiterungen (Seiten, Menüeinträge, Startseiten-Bereiche, Player-Knöpfe …).
//
// Plugins haben vollen Zugriff auf die App (Backend-Befehle, Dateisystem, HTTP, Programme, SQL).
import * as React from "react";
import { Component, ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, Episode, errorText, imageUrl, InstalledPlugin, PluginManifest, Series, Settings, videoUrl } from "../api";
import type { Route, MenuItem, Toast } from "../store";
import { Modal } from "../components/ui";
import { episodeCode, episodeTitle, formatBytes, formatDate, formatDuration, relativeTime } from "../format";
import { t } from "../i18n";

// ---------------------------------------------------------------------------
// Typen der Erweiterungspunkte
// ---------------------------------------------------------------------------

/** Inhalt, den ein Plugin anzeigt: entweder React (`render`) oder direktes DOM (`mount`). */
export type ViewSpec<C = unknown> = {
  render?: (ctx: C) => ReactNode;
  mount?: (el: HTMLElement, ctx: C) => void | (() => void);
};

type Owned = { pluginId: string; uid: string };

export type PageContribution = Owned &
  ViewSpec<{ params: Record<string, string> }> & {
    id: string;
    title: string;
    icon?: string;
    /** "top" = Hauptnavigation, "more" = Menü „Mehr“ (Standard), "none" = nur per navigate erreichbar */
    nav?: "top" | "more" | "none";
  };
export type MenuContribution<T> = Owned & {
  label: string | ((item: T) => string);
  icon?: string;
  danger?: boolean;
  when?: (item: T) => boolean;
  onClick: (item: T) => void;
};
export type HomeSectionContribution = Owned & ViewSpec<{ series: Series[] }> & { id: string; title?: string; position?: "top" | "bottom" };
export type PlayerButtonContribution = Owned & { label: string; icon?: string; onClick: (ctx: PlayerContext) => void };
export type SettingsContribution = Owned & ViewSpec<Record<string, never>>;
export type ShortcutContribution = Owned & { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; inPlayer?: boolean; run: (e: KeyboardEvent) => void };

export type PlayerContext = { episode: Episode; series: Series | null; video: HTMLVideoElement | null };

type Registry = {
  pages: PageContribution[];
  episodeMenu: MenuContribution<Episode>[];
  seriesMenu: MenuContribution<Series>[];
  homeSections: HomeSectionContribution[];
  playerButtons: PlayerButtonContribution[];
  settings: SettingsContribution[];
  shortcuts: ShortcutContribution[];
};

export type PluginStatus = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  builtin: boolean;
  enabled: boolean;
  active: boolean;
  error: string | null;
  dir: string | null;
  manifest: PluginManifest;
};

/** Ein eingebautes Plugin: gleiche API wie externe Plugins, nur fest im Programm enthalten. */
export type BuiltinPlugin = { manifest: PluginManifest & { id: string; name: string }; activate: Activate };
type Activate = (nexus: Nexus) => void | (() => void) | { deactivate?: () => void; exports?: unknown } | Promise<unknown>;

/** Was die App dem Host zur Verfügung stellt (wird bei jedem Render aktualisiert). */
export type StoreBridge = {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  series: Series[];
  route: Route;
  navigate: (r: Route) => void;
  back: () => void;
  toast: (kind: Toast["kind"], title: string, message?: string, action?: Toast["action"]) => void;
  openDialog: (node: ReactNode) => void;
  closeDialog: () => void;
  openMenu: (e: { clientX: number; clientY: number }, items: MenuItem[]) => void;
  play: (episodeId: string) => void;
  closePlayer: () => void;
  bump: () => void;
};

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

const EMPTY: Registry = { pages: [], episodeMenu: [], seriesMenu: [], homeSections: [], playerButtons: [], settings: [], shortcuts: [] };
let registry: Registry = EMPTY;
let statuses: PluginStatus[] = [];
let snapshot = { registry, statuses };
const listeners = new Set<() => void>();
const notify = () => {
  snapshot = { registry, statuses };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** React-Hook: aktuelle Erweiterungen und Plugin-Status. */
export const usePlugins = () => useSyncExternalStore(subscribe, () => snapshot);

let bridge: StoreBridge | null = null;
export const setStoreBridge = (b: StoreBridge) => {
  bridge = b;
};
let appInfo = { version: "", dataDir: "" };
/** Wird direkt nach dem Start gesetzt – noch bevor Plugins aktiviert werden. */
export const setAppInfo = (info: typeof appInfo) => {
  appInfo = info;
};
const store = () => {
  if (!bridge) throw new Error("NEXUS ist noch nicht bereit");
  return bridge;
};

type Active = { cleanups: (() => void)[]; exports: unknown; storage: Record<string, unknown> };
const active = new Map<string, Active>();
let builtins: BuiltinPlugin[] = [];
let keyCounter = 0;

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

export type PluginEvent =
  | "app:ready"
  | "route:change"
  | "library:changed"
  | "settings:changed"
  | "scan:progress"
  | "scan:finished"
  | "metadata:updated"
  | "fileops:finished"
  | "player:open"
  | "player:close"
  | "player:progress"
  | "player:ended"
  | "episode:watched"
  | "plugins:changed";

const handlers = new Map<string, Set<(payload: any) => void>>();

/** Löst ein Ereignis für alle Plugins aus. Fehler einzelner Plugins stören die App nicht. */
export function emit(name: PluginEvent | string, payload?: unknown) {
  const set = handlers.get(name);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      const r = fn(payload) as unknown;
      if (r instanceof Promise) r.catch((e) => api.log("error", `Plugin-Ereignis ${name}: ${errorText(e)}`));
    } catch (e) {
      api.log("error", `Plugin-Ereignis ${name}: ${errorText(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Player-Verbindung
// ---------------------------------------------------------------------------

let player: { ctx: PlayerContext; controls: PlayerControls } | null = null;
export type PlayerControls = {
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  next: () => void;
  previous: () => void;
  close: () => void;
  osd: (text: string) => void;
};
export const setPlayer = (p: typeof player) => {
  player = p;
};

// ---------------------------------------------------------------------------
// Die API für Plugins
// ---------------------------------------------------------------------------

export type Nexus = ReturnType<typeof createNexus>;

function createNexus(info: { id: string; manifest: PluginManifest; builtin: boolean; dir: string | null }, a: Active) {
  const { id } = info;
  const own = <T extends object>(list: keyof Registry, item: T) => {
    const entry = { ...item, pluginId: id, uid: `${id}:${++keyCounter}` } as any;
    registry = { ...registry, [list]: [...registry[list], entry] };
    notify();
    const dispose = () => {
      registry = { ...registry, [list]: (registry[list] as any[]).filter((x) => x !== entry) };
      notify();
    };
    a.cleanups.push(dispose);
    return dispose;
  };
  const saveStorage = (key: string, value: unknown) => {
    if (value === undefined || value === null) delete a.storage[key];
    else a.storage[key] = value;
    return api.pluginStorageSet(id, key, value ?? null);
  };
  const configListeners = new Set<(key: string, value: unknown) => void>();
  const fields = info.manifest.settings ?? [];

  const nexus = {
    /** React der App – für Komponenten mit Hooks (`nexus.React.useState` …). */
    React,
    /** Kurzform für React.createElement – JSX-Ersatz ohne Build-Schritt. */
    h: React.createElement,
    plugin: {
      id,
      name: info.manifest.name ?? id,
      version: info.manifest.version ?? "",
      builtin: info.builtin,
      dir: info.dir,
      manifest: info.manifest,
      /** Liest eine Datei aus dem eigenen Plugin-Ordner (Text). */
      readFile: (path: string) => (info.builtin ? Promise.reject(new Error("Eingebaute Plugins haben keinen Ordner")) : api.pluginReadFile(id, path)),
    },
    app: {
      get version() {
        return appInfo.version;
      },
      get dataDir() {
        return appInfo.dataDir;
      },
      language: () => store().settings.language,
    },
    /** Rohzugriff auf jeden Backend-Befehl. */
    invoke: <T = any,>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args),
    /** Alle typisierten Backend-Funktionen der App (siehe src/api.ts). */
    api,
    log: (level: "info" | "warn" | "error", ...msg: unknown[]) => {
      const text = msg.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ");
      api.log(level, `[Plugin ${id}] ${text}`);
      (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${id}]`, ...msg);
    },
    events: {
      on: (name: PluginEvent | string, fn: (payload: any) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        const off = () => handlers.get(name)?.delete(fn);
        a.cleanups.push(off);
        return off;
      },
      /** Eigene Ereignisse – z. B. zur Kommunikation zwischen Plugins. */
      emit: (name: string, payload?: unknown) => emit(name, payload),
    },
    ui: {
      addPage: (p: Omit<PageContribution, keyof Owned>) => own("pages", { nav: "more", ...p }),
      addEpisodeMenuItem: (m: Omit<MenuContribution<Episode>, keyof Owned>) => own("episodeMenu", m),
      addSeriesMenuItem: (m: Omit<MenuContribution<Series>, keyof Owned>) => own("seriesMenu", m),
      addHomeSection: (s: Omit<HomeSectionContribution, keyof Owned>) => own("homeSections", s),
      addPlayerButton: (b: Omit<PlayerButtonContribution, keyof Owned>) => own("playerButtons", b),
      addSettings: (s: Omit<SettingsContribution, keyof Owned>) => own("settings", s),
      addShortcut: (s: Omit<ShortcutContribution, keyof Owned>) => own("shortcuts", s),
      /** Fügt CSS hinzu (z. B. für Themes). Wird beim Deaktivieren entfernt. */
      addStyle: (css: string) => {
        const el = document.createElement("style");
        el.dataset.plugin = id;
        el.textContent = css;
        document.head.appendChild(el);
        const dispose = () => el.remove();
        a.cleanups.push(dispose);
        return dispose;
      },
      toast: (kind: Toast["kind"], title: string, message?: string) => store().toast(kind, title, message),
      navigate: (route: Route | string, params?: Record<string, string>) =>
        store().navigate(typeof route === "string" ? { name: route as Route["name"], params } : route),
      /** Öffnet eine eigene Plugin-Seite. */
      openPage: (pageId: string, params?: Record<string, string>) => store().navigate({ name: "plugin", params: { plugin: id, page: pageId, ...params } }),
      back: () => store().back(),
      currentRoute: () => store().route,
      openSeries: (seriesId: string) => store().navigate({ name: "series", params: { id: seriesId } }),
      play: (episodeId: string) => store().play(episodeId),
      dialog: (d: { title: string; subtitle?: string; size?: "wide" | "xwide"; buttons?: { label: string; primary?: boolean; danger?: boolean; onClick?: () => unknown }[] } & ViewSpec<{ close: () => void }>) => {
        const close = () => store().closeDialog();
        store().openDialog(<PluginDialog spec={d} close={close} pluginId={id} />);
        return close;
      },
      confirm: (title: string, text: string, opts?: { confirmLabel?: string; danger?: boolean }) =>
        new Promise<boolean>((resolve) => store().openDialog(<AskDialog title={title} text={text} confirmLabel={opts?.confirmLabel} danger={opts?.danger} resolve={resolve} />)),
      prompt: (title: string, opts?: { label?: string; initial?: string }) =>
        new Promise<string | null>((resolve) => store().openDialog(<AskDialog title={title} input label={opts?.label} initial={opts?.initial} resolve={resolve} />)),
      /** Zeigt ein Kontextmenü an der Mausposition (z. B. aus einem onClick-Ereignis). */
      menu: (e: { clientX: number; clientY: number }, items: ({ label: string; icon?: string; danger?: boolean; disabled?: boolean; onClick: () => void } | { divider: true } | { title: string })[]) =>
        store().openMenu(e, items.map((it) => ("label" in it ? { ...it, icon: iconNode(it.icon) } : it)) as MenuItem[]),
    },
    library: {
      series: () => store().series,
      seriesById: (sid: string) => store().series.find((s) => s.id === sid) ?? null,
      detail: (sid: string) => api.seriesDetail(sid),
      episodes: (filter: "unwatched" | "continue" | "recent" | "unsorted" | "hidden" | "unavailable" | string, limit?: number) => api.listEpisodes(filter, limit),
      search: (q: string) => api.search(q),
      /** Lädt die Bibliothek neu (nach eigenen Änderungen aufrufen). */
      refresh: () => store().bump(),
    },
    player: {
      current: () => (player ? { ...player.ctx } : null),
      play: () => player?.controls.play(),
      pause: () => player?.controls.pause(),
      seek: (s: number) => player?.controls.seek(s),
      next: () => player?.controls.next(),
      previous: () => player?.controls.previous(),
      close: () => player?.controls.close(),
      osd: (text: string) => player?.controls.osd(text),
    },
    settings: {
      get: () => store().settings,
      update: (patch: Partial<Settings>) => store().updateSettings(patch),
    },
    /** Dauerhafter Speicher dieses Plugins (in der Bibliotheksdatenbank, JSON-Werte). */
    storage: {
      get: <T = unknown,>(key: string, fallback?: T): T => (key in a.storage ? (a.storage[key] as T) : (fallback as T)),
      set: (key: string, value: unknown) => saveStorage(key, value),
      remove: (key: string) => saveStorage(key, null),
      all: () => ({ ...a.storage }),
    },
    /** Werte der im Manifest unter "settings" beschriebenen Einstellungen. */
    config: {
      get: <T = unknown,>(key: string): T => {
        const v = (a.storage["__config"] as Record<string, unknown> | undefined)?.[key];
        return (v === undefined ? fields.find((f) => f.key === key)?.default : v) as T;
      },
      set: async (key: string, value: unknown) => {
        const cur = { ...((a.storage["__config"] as Record<string, unknown>) ?? {}), [key]: value };
        await saveStorage("__config", cur);
        configListeners.forEach((l) => l(key, value));
        notify();
      },
      onChange: (fn: (key: string, value: unknown) => void) => {
        configListeners.add(fn);
        const off = () => configListeners.delete(fn);
        a.cleanups.push(off);
        return off;
      },
    },
    /** HTTP ohne CORS-Einschränkungen (läuft über das Backend). */
    http: {
      fetch: async (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string | object; timeoutMs?: number }) => {
        let body = opts?.body;
        const headers = { ...(opts?.headers ?? {}) };
        if (body && typeof body === "object") {
          body = JSON.stringify(body);
          if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
        }
        const r = await api.pluginHttp({ url, method: opts?.method, headers, body: body as string | undefined, timeoutMs: opts?.timeoutMs });
        return { ...r, ok: r.status >= 200 && r.status < 300, text: () => r.body, json: <T = any,>() => JSON.parse(r.body) as T };
      },
    },
    fs: {
      read: (path: string) => api.pluginFsRead(path),
      write: (path: string, content: string) => api.pluginFsWrite(path, content, false),
      append: (path: string, content: string) => api.pluginFsWrite(path, content, true),
      list: (path: string) => api.pluginFsList(path),
      exists: (path: string) => api.pluginFsExists(path),
    },
    shell: {
      /** Startet ein Programm. `wait: false` = nicht auf das Ende warten. */
      run: (program: string, args: string[] = [], opts?: { cwd?: string; wait?: boolean }) => api.pluginRun(program, args, opts?.cwd, opts?.wait),
      openFolder: (path: string) => api.openPath(path),
      openUrl: (url: string) => api.openLink(url),
    },
    /** SQL auf der Bibliotheksdatenbank. SELECT liefert Zeilen, sonst { changes }. */
    db: {
      query: <T = any,>(sql: string, params?: unknown[]): Promise<T> => api.pluginSql(sql, params),
    },
    /** Exporte anderer aktiver Plugins (Rückgabewert `exports` von deren activate). */
    plugins: {
      get: (pluginId: string) => active.get(pluginId)?.exports,
      list: () => statuses.map((s) => ({ id: s.id, name: s.name, active: s.active })),
    },
    utils: { episodeCode, episodeTitle, formatBytes, formatDate, formatDuration, relativeTime, imageUrl, videoUrl, t },
  };
  return nexus;
}

// ---------------------------------------------------------------------------
// Laden / Entladen
// ---------------------------------------------------------------------------

function deactivate(id: string) {
  const a = active.get(id);
  if (!a) return;
  for (const c of a.cleanups.reverse()) {
    try {
      c();
    } catch (e) {
      api.log("error", `Plugin ${id} beim Deaktivieren: ${errorText(e)}`);
    }
  }
  document.querySelectorAll(`style[data-plugin="${CSS.escape(id)}"]`).forEach((el) => el.remove());
  active.delete(id);
}

async function loadModule(code: string, id: string): Promise<Activate> {
  // ES-Modul (export default / export function activate) oder klassisches Skript mit `nexus` als Variable
  if (/\bexport\s+(default|function|const|async)\b/.test(code)) {
    const url = URL.createObjectURL(new Blob([`${code}\n//# sourceURL=nexus-plugin://${id}/main.js`], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ url);
      const fn = mod.default ?? mod.activate;
      if (typeof fn !== "function") throw new Error("Das Plugin exportiert keine Funktion (export default function activate(nexus) { … })");
      return fn;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return new Function("nexus", `${code}\n//# sourceURL=nexus-plugin://${id}/main.js`) as Activate;
}

async function activate(info: { id: string; manifest: PluginManifest; builtin: boolean; dir: string | null }, fn: Activate) {
  const a: Active = { cleanups: [], exports: undefined, storage: {} };
  try {
    a.storage = await api.pluginStorageGet(info.id);
  } catch {
    /* leerer Speicher */
  }
  active.set(info.id, a);
  try {
    if (!info.builtin) {
      for (const file of info.manifest.styles ?? []) {
        const css = await api.pluginReadFile(info.id, file);
        const el = document.createElement("style");
        el.dataset.plugin = info.id;
        el.textContent = css;
        document.head.appendChild(el);
      }
    }
    const r = await fn(createNexus(info, a));
    if (typeof r === "function") a.cleanups.unshift(r as () => void);
    else if (r && typeof r === "object") {
      const o = r as { deactivate?: () => void; exports?: unknown };
      if (typeof o.deactivate === "function") a.cleanups.unshift(o.deactivate);
      a.exports = o.exports;
    }
  } catch (e) {
    deactivate(info.id);
    throw e;
  }
}

let loading: Promise<void> | null = null;

/** Lädt alle Plugins neu (nach Installieren, Ändern, Aktivieren …). */
export function reloadPlugins(): Promise<void> {
  const run = async () => {
    for (const id of [...active.keys()]) deactivate(id);
    registry = EMPTY;
    let overview: { plugins: InstalledPlugin[]; states: Record<string, boolean>; dir: string } = { plugins: [], states: {}, dir: "" };
    try {
      overview = await api.pluginList();
    } catch (e) {
      api.log("error", `Plugin-Liste: ${errorText(e)}`);
    }
    pluginsDir = overview.dir;
    const next: PluginStatus[] = [];
    const isOn = (id: string, m: PluginManifest) => overview.states[id] ?? m.defaultEnabled ?? false;

    for (const b of builtins) {
      const st: PluginStatus = {
        id: b.manifest.id, name: b.manifest.name, version: b.manifest.version ?? "", description: b.manifest.description ?? "",
        author: b.manifest.author ?? "NEXUS ANIME", builtin: true, enabled: isOn(b.manifest.id, b.manifest), active: false, error: null, dir: null, manifest: b.manifest,
      };
      if (st.enabled) {
        try {
          await activate({ id: st.id, manifest: b.manifest, builtin: true, dir: null }, b.activate);
          st.active = true;
        } catch (e) {
          st.error = errorText(e);
          api.log("error", `Eingebautes Plugin ${st.id}: ${st.error}`);
        }
      }
      next.push(st);
    }
    for (const p of overview.plugins) {
      const m = p.manifest;
      const st: PluginStatus = {
        id: p.id, name: m.name ?? p.id, version: m.version ?? "", description: m.description ?? "", author: m.author ?? "",
        builtin: false, enabled: isOn(p.id, m), active: false, error: p.error, dir: p.dir, manifest: m,
      };
      if (builtins.some((b) => b.manifest.id === p.id)) st.error = "Diese ID ist bereits von einem eingebauten Plugin belegt";
      if (st.enabled && !st.error) {
        try {
          const code = await api.pluginReadFile(p.id, m.main ?? "main.js");
          await activate({ id: p.id, manifest: m, builtin: false, dir: p.dir }, await loadModule(code, p.id));
          st.active = true;
          api.log("info", `Plugin ${p.id} ${m.version ?? ""} geladen`);
        } catch (e) {
          st.error = errorText(e);
          api.log("error", `Plugin ${p.id}: ${st.error}`);
        }
      }
      next.push(st);
    }
    statuses = next;
    notify();
    emit("plugins:changed", statuses);
  };
  // Aufrufe nacheinander ausführen, nie parallel
  loading = (loading ?? Promise.resolve()).then(run, run);
  return loading;
}

let pluginsDir = "";
export const getPluginsDir = () => pluginsDir;

export function registerBuiltins(list: BuiltinPlugin[]) {
  builtins = list;
}

export async function setPluginEnabled(id: string, enabled: boolean) {
  await api.pluginSetEnabled(id, enabled);
  await reloadPlugins();
}

/** Speichert eine Einstellung aus dem Manifest-Formular (ohne das Plugin neu zu laden). */
export async function setPluginConfig(id: string, key: string, value: unknown) {
  const a = active.get(id);
  const cur = { ...((a?.storage["__config"] as Record<string, unknown>) ?? {}), [key]: value };
  if (a) a.storage["__config"] = cur;
  await api.pluginStorageSet(id, "__config", cur);
  emit(`config:${id}`, { key, value });
  notify();
}
export const getPluginConfig = (id: string) => (active.get(id)?.storage["__config"] as Record<string, unknown> | undefined) ?? {};

// ---------------------------------------------------------------------------
// Darstellung von Plugin-Inhalten
// ---------------------------------------------------------------------------

/** Symbol aus Plugins: Emoji/Text oder ein SVG-String. */
export function iconNode(icon?: string): ReactNode {
  if (!icon) return undefined;
  if (icon.trim().startsWith("<svg")) return <span className="plugin-icon" dangerouslySetInnerHTML={{ __html: icon }} />;
  return <span className="plugin-icon">{icon}</span>;
}

class Boundary extends Component<{ pluginId: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: errorText(e) };
  }
  componentDidCatch(e: unknown) {
    api.log("error", `Plugin ${this.props.pluginId} (Anzeige): ${errorText(e)}`);
  }
  render() {
    if (this.state.error)
      return (
        <div className="plugin-error">
          <b>{t("plugins.renderError", { p: this.props.pluginId })}</b>
          <div>{this.state.error}</div>
        </div>
      );
    return this.props.children;
  }
}

function Mounted<C>({ spec, ctx }: { spec: ViewSpec<C>; ctx: C }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !spec.mount) return;
    const el = ref.current;
    const cleanup = spec.mount(el, ctx);
    return () => {
      if (typeof cleanup === "function") cleanup();
      el.innerHTML = "";
    };
  }, [spec, JSON.stringify(ctx ?? null)]);
  return <div ref={ref} className="plugin-mount" />;
}

function Rendered<C>({ spec, ctx }: { spec: ViewSpec<C>; ctx: C }) {
  return <>{spec.render!(ctx)}</>;
}

/** Zeigt eine Plugin-Ansicht sicher an – Fehler bleiben auf den Bereich beschränkt. */
export function PluginView<C>({ pluginId, spec, ctx }: { pluginId: string; spec: ViewSpec<C>; ctx: C }) {
  return (
    <Boundary pluginId={pluginId}>
      {spec.render ? <Rendered spec={spec} ctx={ctx} /> : spec.mount ? <Mounted spec={spec} ctx={ctx} /> : null}
    </Boundary>
  );
}

function PluginDialog({ spec, close, pluginId }: { spec: Parameters<Nexus["ui"]["dialog"]>[0]; close: () => void; pluginId: string }) {
  return (
    <Modal
      title={spec.title}
      subtitle={spec.subtitle}
      size={spec.size}
      onClose={close}
      footer={
        spec.buttons?.length ? (
          <>
            {spec.buttons.map((b, i) => (
              <button
                key={i}
                className={`btn ${b.primary ? "primary" : b.danger ? "danger" : "ghost"}`}
                onClick={async () => {
                  const r = await b.onClick?.();
                  if (r !== false) close();
                }}
              >
                {b.label}
              </button>
            ))}
          </>
        ) : undefined
      }
    >
      <PluginView pluginId={pluginId} spec={spec} ctx={{ close }} />
    </Modal>
  );
}

function AskDialog({ title, text, input, label, initial, confirmLabel, danger, resolve }: {
  title: string; text?: string; input?: boolean; label?: string; initial?: string; confirmLabel?: string; danger?: boolean; resolve: (v: any) => void;
}) {
  const [v, setV] = useState(initial ?? "");
  const done = useRef(false);
  const finish = (val: unknown) => {
    if (done.current) return;
    done.current = true;
    resolve(val);
    bridge?.closeDialog();
  };
  return (
    <Modal
      title={title}
      onClose={() => finish(input ? null : false)}
      footer={
        <>
          <button className="btn ghost" onClick={() => finish(input ? null : false)}>{t("common.cancel")}</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={() => finish(input ? v : true)}>{confirmLabel ?? (input ? t("common.save") : t("common.confirm"))}</button>
        </>
      }
    >
      {text && <div style={{ color: "var(--text-2)", lineHeight: 1.6, marginBottom: input ? 12 : 0 }}>{text}</div>}
      {input && (
        <div className="field">
          {label && <label>{label}</label>}
          <input className="input" value={v} autoFocus onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && finish(v)} />
        </div>
      )}
    </Modal>
  );
}

/** Wandelt Plugin-Menüeinträge in Menüeinträge der App um. */
export function pluginMenuItems<T>(list: MenuContribution<T>[], item: T): MenuItem[] {
  const out: MenuItem[] = [];
  for (const m of list) {
    try {
      if (m.when && !m.when(item)) continue;
      out.push({
        label: typeof m.label === "function" ? m.label(item) : m.label,
        icon: iconNode(m.icon),
        danger: m.danger,
        onClick: () => {
          try {
            const r = m.onClick(item) as unknown;
            if (r instanceof Promise) r.catch((e) => bridge?.toast("error", t("toast.error"), errorText(e)));
          } catch (e) {
            bridge?.toast("error", t("toast.error"), errorText(e));
          }
        },
      });
    } catch (e) {
      api.log("error", `Plugin ${m.pluginId} (Menü): ${errorText(e)}`);
    }
  }
  return out;
}

/** Globale Tastenkürzel der Plugins. */
export function handlePluginShortcut(e: KeyboardEvent, inPlayer: boolean): boolean {
  if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return false;
  for (const s of registry.shortcuts) {
    if (!!s.inPlayer !== inPlayer) continue;
    if (s.key.toLowerCase() !== e.key.toLowerCase() || !!s.ctrl !== e.ctrlKey || !!s.shift !== e.shiftKey || !!s.alt !== e.altKey) continue;
    e.preventDefault();
    try {
      s.run(e);
    } catch (err) {
      api.log("error", `Plugin ${s.pluginId} (Tastenkürzel): ${errorText(err)}`);
    }
    return true;
  }
  return false;
}
