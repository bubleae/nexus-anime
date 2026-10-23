import { ReactNode, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown, ArrowUp, Database, FileCog, Puzzle, Film, FolderOpen, FolderPlus, HardDrive, Image, Info, Library, Link, Palette, Play, Plus, RefreshCw, RotateCcw, Shield, Trash2, Undo2, X,
} from "lucide-react";
import { addLinkSource, moveLinkSource, PLACEHOLDERS, previewTemplate, removeLinkSource, setLinkSourceEnabled, useLinkSources } from "../player/linkSources";
import { api, Episode, Settings as S } from "../api";
import { useStore } from "../store";
import { t, TKey } from "../i18n";
import { formatBytes, formatDate } from "../format";
import { Confirm, Modal, Switch } from "../components/ui";
import { FileOpsDialog } from "../components/dialogs";
import { PluginSettings } from "./Plugins";

type Cat = "general" | "library" | "files" | "playback" | "links" | "metadata" | "plugins" | "data" | "about";
const CATS: { id: Cat; icon: ReactNode; label: TKey }[] = [
  { id: "general", icon: <Palette size={18} />, label: "settings.general" },
  { id: "library", icon: <Library size={18} />, label: "settings.library" },
  { id: "files", icon: <FileCog size={18} />, label: "settings.files" },
  { id: "playback", icon: <Play size={18} />, label: "settings.playback" },
  { id: "links", icon: <Link size={18} />, label: "links.title" },
  { id: "metadata", icon: <Image size={18} />, label: "settings.metadata" },
  { id: "plugins", icon: <Puzzle size={18} />, label: "plugins.title" },
  { id: "data", icon: <Shield size={18} />, label: "settings.data" },
  { id: "about", icon: <Info size={18} />, label: "settings.about" },
];

const ACCENTS: [string, string][] = [
  ["violet", "#8b5cf6"], ["blue", "#3b82f6"], ["turquoise", "#14b8a6"], ["pink", "#ec4899"], ["orange", "#f97316"], ["green", "#22c55e"], ["red", "#ef4444"],
];
const LANGS: [string, string][] = [["jpn", "Japanisch"], ["ger", "Deutsch"], ["eng", "Englisch"], ["fre", "Französisch"], ["spa", "Spanisch"], ["ita", "Italienisch"], ["", "Keine Präferenz"]];

function Row({ label, desc, children, col }: { label: string; desc?: ReactNode; children?: ReactNode; col?: boolean }) {
  return (
    <div className={`setting ${col ? "col" : ""}`}>
      <div className="s-text">
        <div className="s-label">{label}</div>
        {desc && <div className="s-desc">{desc}</div>}
      </div>
      {children && <div className="s-ctrl">{children}</div>}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {desc && <div className="desc">{desc}</div>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}

function Sel<K extends keyof S>({ k, options }: { k: K; options: [string, string][] }) {
  const { settings, updateSettings } = useStore();
  return (
    <select className="select" value={String(settings[k])} onChange={(e) => {
      const raw = e.target.value;
      const v = typeof settings[k] === "number" ? Number(raw) : raw;
      updateSettings({ [k]: v } as Partial<S>);
    }}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function Tog<K extends keyof S>({ k, disabled }: { k: K; disabled?: boolean }) {
  const { settings, updateSettings } = useStore();
  return <Switch checked={!!settings[k]} disabled={disabled} onChange={(v) => updateSettings({ [k]: v } as Partial<S>)} />;
}

// ---------------------------------------------------------------------------
function General() {
  const { settings, updateSettings } = useStore();
  const pages: [string, TKey][] = [["home", "nav.home"], ["library", "nav.library"], ["continue", "nav.continue"], ["favorites", "nav.favorites"], ["recentAdded", "nav.recentAdded"]];
  return (
    <>
      <Section title={t("settings.general")}>
        <Row label={t("settings.language")}><Sel k="language" options={[["de", "Deutsch"], ["en", "English"]]} /></Row>
        <Row label={t("settings.theme")}>
          <Sel k="theme" options={[["dark", t("settings.theme.dark")], ["midnight", t("settings.theme.midnight")], ["light", t("settings.theme.light")]]} />
        </Row>
        <Row label={t("settings.accent")}>
          <div className="swatches">
            {ACCENTS.map(([id, c]) => (
              <button key={id} className={`swatch ${settings.accent === id ? "active" : ""}`} style={{ background: c, color: c }} onClick={() => updateSettings({ accent: id })} title={id} />
            ))}
          </div>
        </Row>
        <Row label={t("settings.animations")}><Tog k="animations" /></Row>
      </Section>
      <Section title={t("settings.startPage")}>
        <Row label={t("settings.startPage")}><Sel k="startPage" options={pages.map(([v, l]) => [v, t(l)])} /></Row>
        <Row label={t("settings.startBehavior")}>
          <Sel k="startBehavior" options={[["startPage", t("settings.startBehavior.startPage")], ["last", t("settings.startBehavior.last")]]} />
        </Row>
        <Row label={t("settings.windowMode")}>
          <Sel k="windowMode" options={[["normal", t("settings.windowMode.normal")], ["maximized", t("settings.windowMode.maximized")]]} />
        </Row>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
function LibrarySettings() {
  const { settings, updateSettings, sources, reloadSources, fail, toast, openDialog, bump } = useStore();
  const [history, setHistory] = useState<any[]>([]);
  const [hidden, setHidden] = useState<Episode[]>([]);
  const loadExtra = () => {
    api.diagnostics().then((d) => setHistory(d.scanHistory ?? [])).catch(() => {});
    api.listEpisodes("hidden", 500).then(setHidden).catch(() => {});
  };
  useEffect(loadExtra, []);
  const addSource = async () => {
    const dir = await open({ directory: true, multiple: true });
    if (!dir) return;
    for (const d of Array.isArray(dir) ? dir : [dir]) {
      try {
        await api.addSource(d, true);
      } catch (e) {
        fail(e);
      }
    }
    toast("info", t("toast.sourceAdded"));
    reloadSources();
  };
  const addExcluded = async () => {
    const dir = await open({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    updateSettings({ excludedPaths: [...new Set([...settings.excludedPaths, dir])] });
  };
  const intervals: [string, string][] = [
    ["0", t("settings.scanInterval.off")], ["15", t("settings.scanInterval.min", { n: 15 })], ["30", t("settings.scanInterval.min", { n: 30 })],
    ["60", t("settings.scanInterval.hours", { n: 1 })], ["180", t("settings.scanInterval.hours", { n: 3 })], ["720", t("settings.scanInterval.hours", { n: 12 })],
  ];
  return (
    <>
      <Section title={t("settings.sources")} desc={t("settings.sourcesText")}>
        {sources.map((s) => (
          <div key={s.id} className={`source-row ${s.available ? "" : "offline"}`}>
            <div className="ic">{s.kind === "library" ? <Library size={18} /> : <HardDrive size={18} />}</div>
            <div className="grow">
              <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{s.path}</div>
              <div className="hint">
                {s.kind === "library" && <span className="tag accent" style={{ marginRight: 6 }}>{t("settings.libraryRole")}</span>}
                {!s.available && <span className="tag warn" style={{ marginRight: 6 }}>{t("settings.sourceOffline")}</span>}
                {t("settings.sourceEpisodes", { n: s.episodeCount })} · {s.lastScanAt ? t("settings.sourceLastScan", { d: formatDate(s.lastScanAt) }) : t("settings.sourceNever")}
              </div>
            </div>
            <Switch checked={s.enabled} onChange={(v) => api.setSourceEnabled(s.id, v).then(reloadSources).catch(fail)} />
            <button className="icon-btn" title={t("scan.start")} disabled={!s.available} onClick={() => api.startScan([s.id]).then(() => toast("info", t("toast.scanStarted"))).catch(fail)}><RefreshCw size={16} /></button>
            <button className="icon-btn" title={t("ep.openFolder")} onClick={() => api.openPath(s.path).catch(fail)}><FolderOpen size={16} /></button>
            <button className="icon-btn" title={t("settings.removeSource")} onClick={() => openDialog(<RemoveSourceDialog id={s.id} path={s.path} onDone={() => { reloadSources(); bump(); }} />)}><X size={16} /></button>
          </div>
        ))}
        <div className="setting">
          <div className="btn-row">
            <button className="btn primary" onClick={addSource}><FolderPlus size={16} /> {t("settings.addSource")}</button>
            <button className="btn" onClick={() => api.startScan().then(() => toast("info", t("toast.scanStarted"))).catch(fail)}><RefreshCw size={16} /> {t("scan.start")}</button>
          </div>
        </div>
      </Section>
      <Section title={t("settings.scanSection")}>
        <Row label={t("settings.scanOnStart")}><Tog k="scanOnStart" /></Row>
        <Row label={t("settings.watchFolders")} desc={t("settings.watchFoldersText")}><Tog k="watchFolders" /></Row>
        <Row label={t("settings.scanInterval")}><Sel k="scanIntervalMinutes" options={intervals} /></Row>
        <Row label={t("settings.duplicates")}><Sel k="duplicateHandling" options={[["versions", t("settings.duplicates.versions")], ["ignore", t("settings.duplicates.ignore")]]} /></Row>
        <Row label={t("settings.unrecognized")}><Sel k="unrecognizedHandling" options={[["unsorted", t("settings.unrecognized.unsorted")], ["ignore", t("settings.unrecognized.ignore")]]} /></Row>
        <Row label={t("settings.missingDrive")}><Sel k="missingDriveBehavior" options={[["keep", t("settings.missingDrive.keep")], ["hide", t("settings.missingDrive.hide")]]} /></Row>
      </Section>
      <Section title={t("settings.excluded")} desc={t("settings.excludedText")}>
        {settings.excludedPaths.map((p) => (
          <div className="source-row" key={p}>
            <div className="grow" style={{ wordBreak: "break-all" }}>{p}</div>
            <button className="icon-btn" onClick={() => updateSettings({ excludedPaths: settings.excludedPaths.filter((x) => x !== p) })}><X size={16} /></button>
          </div>
        ))}
        <div className="setting"><button className="btn" onClick={addExcluded}><FolderPlus size={16} /> {t("settings.addExcluded")}</button></div>
      </Section>
      <Section title={t("settings.hidden")} desc={t("settings.hiddenText")}>
        {hidden.length === 0 && <div className="setting hint">{t("common.none")}</div>}
        <div style={{ maxHeight: 300, overflowY: "auto" }}>
          {hidden.map((e) => (
            <div className="source-row" key={e.id}>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{e.fileName}</div>
                <div className="hint" style={{ wordBreak: "break-all" }}>{e.filePath}</div>
              </div>
              <button className="btn small" onClick={() => api.restoreEpisodes([e.id]).then(() => { loadExtra(); bump(); }).catch(fail)}><Undo2 size={14} /> {t("unsorted.restore")}</button>
            </div>
          ))}
        </div>
      </Section>
      <Section title={t("settings.scanHistory")}>
        {history.length === 0 && <div className="setting hint">{t("common.none")}</div>}
        {history.map((h) => (
          <div className="source-row" key={h.id}>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{formatDate(h.started_at)} · {h.status === "done" ? t("scan.done") : h.status === "cancelled" ? t("scan.cancelled") : h.status === "running" ? t("scan.scanning") : t("scan.error")}</div>
              <div className="hint">
                {t("scan.found", { n: h.files_found })} · {t("scan.summary", { added: h.added, moved: h.moved, missing: h.missing, unsorted: h.unsorted })}
                {JSON.parse(h.errors || "[]").length > 0 && ` · ${t("scan.errors", { n: JSON.parse(h.errors).length })}`}
              </div>
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}

function RemoveSourceDialog({ id, path, onDone }: { id: string; path: string; onDone: () => void }) {
  const { closeDialog, fail } = useStore();
  const go = (removeEntries: boolean) => api.removeSource(id, removeEntries).then(() => { closeDialog(); onDone(); }).catch(fail);
  return (
    <Modal title={t("settings.removeSource")} subtitle={path} onClose={closeDialog}
      footer={<>
        <button className="btn ghost" onClick={closeDialog}>{t("common.cancel")}</button>
        <button className="btn danger" onClick={() => go(true)}>{t("settings.removeSourceDelete")}</button>
        <button className="btn primary" onClick={() => go(false)}>{t("settings.removeSourceKeep")}</button>
      </>}>
      <p style={{ marginTop: 0, color: "var(--text-2)" }}>{t("settings.removeSourceText")}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function Files() {
  const { settings, updateSettings, openDialog } = useStore();
  const [scheme, setScheme] = useState(settings.namingScheme);
  const chooseLibrary = async () => {
    const dir = await open({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    updateSettings({ libraryPath: dir });
  };
  const example = (() => {
    const lib = settings.libraryPath ?? "D:\\Anime-Bibliothek";
    const name = settings.autoRename ? scheme.replace("{series}", "Naruto").replace("{season}", "01").replace("{episode}", "02").replace("{title}", "Mein Name ist Konohamaru").replace("{resolution}", "1080p") : "[Gruppe] Naruto - 02 [1080p]";
    return `${lib}\\Naruto\\${settings.seasonFolders ? "Staffel 01\\" : ""}${name}.mp4`;
  })();
  return (
    <>
      <Section title={t("settings.fileMode")} desc={t("settings.fileModeText")}>
        <div style={{ padding: "6px 22px 16px" }}>
          {(["reference", "copy", "move"] as const).map((m) => (
            <label key={m} className={`radio-card ${settings.fileMode === m ? "active" : ""}`}>
              <input type="radio" checked={settings.fileMode === m} onChange={() => updateSettings({ fileMode: m })} />
              <div>{t(`settings.fileMode.${m}`)}</div>
            </label>
          ))}
        </div>
      </Section>
      <Section title={t("settings.libraryPath")} desc={t("settings.libraryPathText")}>
        <Row label={settings.libraryPath ?? t("settings.noLibrary")}>
          <button className="btn" onClick={chooseLibrary}><FolderOpen size={16} /> {t("settings.chooseLibrary")}</button>
          {settings.libraryPath && <button className="icon-btn" onClick={() => updateSettings({ libraryPath: null })}><X size={16} /></button>}
        </Row>
        <Row label={t("settings.autoRename")}><Tog k="autoRename" /></Row>
        <Row label={t("settings.namingScheme")} desc={t("settings.namingSchemeText")}>
          <input className="input" style={{ width: 320 }} value={scheme} disabled={!settings.autoRename}
            onChange={(e) => setScheme(e.target.value)} onBlur={() => scheme.trim() && updateSettings({ namingScheme: scheme.trim() })} />
        </Row>
        <Row label={t("settings.seasonFolders")}><Tog k="seasonFolders" /></Row>
        <Row label={t("settings.examplePath")} desc={<span style={{ wordBreak: "break-all" }}>{example}</span>} />
      </Section>
      <Section title={t("settings.conflicts")}>
        <Row label={t("settings.previewFileOps")} desc={t("settings.previewAlways")}><Switch checked disabled onChange={() => {}} /></Row>
        <Row label={t("settings.conflicts")}><Sel k="conflictPolicy" options={[["skip", t("settings.conflicts.skip")], ["rename", t("settings.conflicts.rename")]]} /></Row>
        <Row label={t("settings.backupBefore")}><Tog k="backupBeforeChanges" /></Row>
        <div className="setting">
          <button className="btn primary" disabled={!settings.libraryPath} onClick={() => openDialog(<FileOpsDialog request={{ mode: settings.fileMode === "move" ? "move" : "copy", onlyOutside: true }} />)}>
            <Library size={16} /> {t("settings.organizeNow")}
          </button>
          {!settings.libraryPath && <span className="hint">{t("fileops.noLibrary")}</span>}
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
function KeyBind({ action }: { action: string }) {
  const { settings, updateSettings } = useStore();
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      updateSettings({ shortcuts: { ...settings.shortcuts, [action]: e.key } });
      setListening(false);
    };
    window.addEventListener("keydown", h, { capture: true, once: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [listening]);
  const key = settings.shortcuts[action];
  const label = key === " " ? "Leertaste" : key?.replace("Arrow", "Pfeil ").replace("Escape", "Esc");
  return <button className={`keycap ${listening ? "listening" : ""}`} onClick={() => setListening(true)}>{listening ? t("settings.pressKey") : label}</button>;
}

function Playback() {
  const { settings, updateSettings } = useStore();
  const defaults: Record<string, string> = { playPause: " ", seekForward: "ArrowRight", seekBackward: "ArrowLeft", volumeUp: "ArrowUp", volumeDown: "ArrowDown", mute: "m", fullscreen: "f", nextEpisode: "n", previousEpisode: "p", subtitles: "c", speedUp: "]", speedDown: "[", close: "Escape" };
  return (
    <>
      <Section title={t("settings.playback")} desc={t("settings.codecInfo")}>
        <Row label={t("settings.volume")} desc={`${Math.round(settings.defaultVolume * 100)} %`}>
          <input type="range" min={0} max={1} step={0.05} style={{ width: 220 }} value={settings.defaultVolume} onChange={(e) => updateSettings({ defaultVolume: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.speed")}><Sel k="defaultSpeed" options={[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => [String(v), `${v.toLocaleString("de-DE")}×`])} /></Row>
        <Row label={t("settings.autoResume")}><Tog k="autoResume" /></Row>
        <Row label={t("settings.autoNext")}><Tog k="autoNext" /></Row>
        <Row label={t("settings.endBehavior")}>
          <Sel k="endBehavior" options={[["countdown", t("settings.endBehavior.countdown")], ["next", t("settings.endBehavior.next")], ["stop", t("settings.endBehavior.stop")]]} />
        </Row>
        <Row label={t("settings.countdown")}><Sel k="nextCountdownSeconds" options={[5, 10, 15, 20, 30].map((v) => [String(v), `${v} s`])} /></Row>
        <Row label={t("settings.watchedPercent")}><Sel k="markWatchedPercent" options={[80, 85, 90, 95, 98].map((v) => [String(v), `${v} %`])} /></Row>
        <Row label={t("settings.playerWindow")}><Sel k="playerWindowMode" options={[["window", t("settings.playerWindow.window")], ["fullscreen", t("settings.playerWindow.fullscreen")]]} /></Row>
        <Row label={t("settings.thumbnails")}><Tog k="generateThumbnails" /></Row>
      </Section>
      <Section title={t("player.subtitles")}>
        <Row label={t("settings.subLang")}><Sel k="preferredSubtitleLang" options={LANGS} /></Row>
        <Row label={t("settings.audioLang")}><Sel k="preferredAudioLang" options={LANGS} /></Row>
        <Row label={t("settings.subtitleSize")} desc={`${settings.subtitleSize} %`}>
          <input type="range" min={60} max={200} step={10} style={{ width: 220 }} value={settings.subtitleSize} onChange={(e) => updateSettings({ subtitleSize: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.subtitleColor")}>
          <div className="swatches">
            {["#ffffff", "#ffeb3b", "#7df9ff", "#b8ff9f"].map((c) => (
              <button key={c} className={`swatch ${settings.subtitleColor === c ? "active" : ""}`} style={{ background: c, color: c }} onClick={() => updateSettings({ subtitleColor: c })} />
            ))}
          </div>
        </Row>
        <Row label={t("settings.subtitleBackground")}><Tog k="subtitleBackground" /></Row>
        <div className="setting" style={{ justifyContent: "center", background: "#000", minHeight: 90 }}>
          <span style={{ color: settings.subtitleColor, fontSize: `${(22 * settings.subtitleSize) / 100}px`, background: settings.subtitleBackground ? "rgba(0,0,0,.75)" : "transparent", padding: "2px 10px", textShadow: settings.subtitleBackground ? "none" : "0 0 4px #000, 0 0 4px #000", fontWeight: 600 }}>
            Glaubst du an das Schicksal?
          </span>
        </div>
      </Section>
      <Section title={t("settings.shortcuts")} desc={t("settings.shortcutsText")}>
        {Object.keys(defaults).map((a) => (
          <Row key={a} label={t(`shortcut.${a}` as TKey)}><KeyBind action={a} /></Row>
        ))}
        <div className="setting"><button className="btn" onClick={() => updateSettings({ shortcuts: defaults })}><RotateCcw size={16} /> {t("settings.resetShortcuts")}</button></div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
function LinkSources() {
  const { toast } = useStore();
  const list = useLinkSources();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);

  let preview: string | null = null;
  let previewError: string | null = null;
  if (template.trim()) {
    try {
      preview = previewTemplate(template.trim());
    } catch (e) {
      previewError = e instanceof Error ? e.message : String(e);
    }
  }

  const add = () => {
    try {
      const s = addLinkSource(name, template);
      setName("");
      setTemplate("");
      setError(null);
      toast("success", t("links.added"), s.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <Section title={t("links.title")} desc={t("links.text")}>
        <div className="setting col">
          <div className="row" style={{ width: "100%" }}>
            <div className="field" style={{ flex: "0 0 200px" }}>
              <label>{t("links.name")}</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t("links.template")}</label>
              <input
                className="input"
                value={template}
                placeholder="http://192.168.1.10:8080/anime/{slug}/S{season:02}E{episode:02}.m3u8"
                onChange={(e) => {
                  setTemplate(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && template.trim() && add()}
              />
            </div>
          </div>
          {preview && <div className="hint link-preview">{t("links.preview")} → {preview}</div>}
          {(previewError || error) && <div className="plugin-error" style={{ margin: "4px 0 0" }}>{previewError ?? error}</div>}
          <div className="hint" style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 6 }}>
            {t("links.placeholders")} {PLACEHOLDERS.map((p) => <code key={p} className="link-ph">{p}</code>)}
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={!template.trim() || !!previewError} onClick={add}><Plus size={16} /> {t("links.add")}</button>
          </div>
        </div>
      </Section>
      <Section title={t("links.list")} desc={t("links.order")}>
        {list.length === 0 && <div className="setting"><span className="hint">{t("links.empty")}</span></div>}
        {list.map((s, i) => (
          <div key={s.id} className="setting">
            <div className="s-text" style={{ minWidth: 0 }}>
              <div className="s-label" style={{ opacity: s.enabled ? 1 : 0.55 }}>{i + 1}. {s.name}</div>
              <div className="s-desc link-template">{s.template}</div>
            </div>
            <div className="s-ctrl">
              <Switch checked={s.enabled} onChange={(v) => setLinkSourceEnabled(s.id, v)} />
              <button className="icon-btn" title={t("links.up")} disabled={i === 0} onClick={() => moveLinkSource(s.id, -1)}><ArrowUp size={16} /></button>
              <button className="icon-btn" title={t("links.down")} disabled={i === list.length - 1} onClick={() => moveLinkSource(s.id, 1)}><ArrowDown size={16} /></button>
              <button className="icon-btn" title={t("links.remove")} onClick={() => removeLinkSource(s.id)}><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
function Metadata() {
  const { fail, toast, metadataBusy } = useStore();
  return (
    <Section title={t("settings.metadata")} desc={t("settings.autoMetadataText")}>
      <Row label={t("settings.autoMetadata")}><Tog k="autoMetadata" /></Row>
      <Row label={t("settings.titleLanguage")} desc={t("settings.descriptionLang")}>
        <Sel k="titleLanguage" options={[["romaji", t("settings.titleLanguage.romaji")], ["english", t("settings.titleLanguage.english")], ["native", t("settings.titleLanguage.native")]]} />
      </Row>
      <Row label={t("settings.coverQuality")}>
        <Sel k="coverQuality" options={[["extraLarge", t("settings.coverQuality.extraLarge")], ["large", t("settings.coverQuality.large")], ["medium", t("settings.coverQuality.medium")]]} />
      </Row>
      <Row label={metadataBusy ? t("settings.metaRunning") : t("series.refreshMetadata")}>
        <button className="btn" onClick={() => api.metadataRefresh(null, false).then(() => toast("info", t("meta.loading"))).catch(fail)}><RefreshCw size={16} /> {t("settings.refreshMissing")}</button>
        <button className="btn" onClick={() => api.metadataRefresh(null, true).then(() => toast("info", t("meta.loading"))).catch(fail)}>{t("settings.refreshAll")}</button>
      </Row>
      <Row label={t("settings.metadataCache")}>
        <button className="btn" onClick={() => api.clearCache("metadata").then(() => toast("success", t("settings.cleared"))).catch(fail)}><Trash2 size={16} /> {t("settings.metadataCache")}</button>
      </Row>
      <Row label={t("edit.cover")} desc={t("settings.customImages")} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
function Data() {
  const { boot, fail, toast, openDialog, bump, updateSettings, settings } = useStore();
  const [backups, setBackups] = useState<{ path: string; name: string; size: number | null }[]>([]);
  const [diag, setDiag] = useState<Record<string, any> | null>(null);
  const load = () => {
    api.listBackups().then(setBackups).catch(() => {});
    api.diagnostics().then(setDiag).catch(() => {});
  };
  useEffect(load, []);
  const restore = (path: string) =>
    openDialog(<Confirm title={t("settings.restoreBackup")} text={t("settings.restoreText")} danger confirmLabel={t("settings.restoreBackup")} onConfirm={async () => { await api.restoreBackup(path); toast("success", t("settings.backupRestored")); bump(); load(); }} />);
  return (
    <>
      <Section title={t("settings.dbLocation")}>
        <Row label={boot?.databasePath ?? "–"} desc={diag ? formatBytes(diag.databaseSize) : undefined}>
          <button className="btn" onClick={async () => {
            const dir = await open({ directory: true });
            if (!dir || Array.isArray(dir)) return;
            try {
              const p = await api.moveDatabase(dir);
              toast("success", t("common.restartRequired"), t("settings.moveDbDone", { p }), { label: "Neu starten", run: () => api.restart() });
            } catch (e) { fail(e); }
          }}><Database size={16} /> {t("settings.moveDb")}</button>
          <button className="btn ghost" onClick={() => api.resetDatabaseLocation().then(() => toast("info", t("common.restartRequired"))).catch(fail)}>{t("settings.resetDb")}</button>
        </Row>
      </Section>
      <Section title={t("settings.backup")}>
        <Row label={t("settings.backup")}>
          <button className="btn primary" onClick={() => api.createBackup().then((p) => { toast("success", t("settings.backupCreated", { p })); load(); }).catch(fail)}>{t("settings.createBackup")}</button>
          <button className="btn" onClick={async () => {
            const p = await save({ defaultPath: `nexus-backup-${new Date().toISOString().slice(0, 10)}.db`, filters: [{ name: "NEXUS-Backup", extensions: ["db"] }] });
            if (p) api.createBackup(p).then((r) => toast("success", t("settings.backupCreated", { p: r }))).catch(fail);
          }}>{t("settings.createBackupAs")}</button>
          <button className="btn" onClick={async () => {
            const p = await open({ filters: [{ name: "NEXUS-Backup", extensions: ["db"] }] });
            if (p && !Array.isArray(p)) restore(p);
          }}>{t("settings.restoreBackup")}</button>
        </Row>
        {backups.slice(0, 6).map((b) => (
          <div className="source-row" key={b.path}>
            <div className="grow"><div style={{ fontWeight: 600 }}>{b.name}</div><div className="hint">{formatBytes(b.size)}</div></div>
            <button className="btn small" onClick={() => restore(b.path)}><Undo2 size={14} /> {t("unsorted.restore")}</button>
          </div>
        ))}
        <Row label={t("settings.export")}>
          <button className="btn" onClick={async () => {
            const p = await save({ defaultPath: "nexus-anime-export.json", filters: [{ name: "JSON", extensions: ["json"] }] });
            if (p) api.exportLibrary(p).then(() => toast("success", t("settings.exported"))).catch(fail);
          }}>{t("settings.export")}</button>
          <button className="btn" onClick={async () => {
            const p = await open({ filters: [{ name: "JSON", extensions: ["json"] }] });
            if (p && !Array.isArray(p)) api.importLibrary(p).then((n) => { toast("success", t("settings.imported", { n })); bump(); }).catch(fail);
          }}>{t("settings.import")}</button>
        </Row>
      </Section>
      <Section title={t("settings.cache")}>
        <Row label={t("settings.clearThumbs")} desc={diag ? formatBytes(diag.thumbsSize) : undefined}>
          <button className="btn" onClick={() => api.clearCache("thumbnails").then(() => { toast("success", t("settings.cleared")); load(); bump(); }).catch(fail)}><Trash2 size={16} /> {t("settings.clearThumbs")}</button>
        </Row>
        <Row label={t("settings.clearSubs")} desc={diag ? formatBytes(diag.subtitlesSize) : undefined}>
          <button className="btn" onClick={() => api.clearCache("subtitles").then(() => { toast("success", t("settings.cleared")); load(); }).catch(fail)}><Trash2 size={16} /> {t("settings.clearSubs")}</button>
        </Row>
        <Row label={t("settings.metadataCache")} desc={diag ? `${diag.metadataCacheEntries} · Bilder ${formatBytes(diag.imagesSize)}` : undefined}>
          <button className="btn" onClick={() => api.clearCache("metadata").then(() => { toast("success", t("settings.cleared")); load(); }).catch(fail)}><Trash2 size={16} /> {t("settings.metadataCache")}</button>
        </Row>
      </Section>
      <Section title={t("settings.diagnostics")}>
        <Row label={t("settings.logs")}>
          <button className="btn" onClick={() => openDialog(<LogsDialog />)}>{t("settings.logs")}</button>
          <button className="btn" onClick={() => api.diagnostics().then((d) => navigator.clipboard.writeText(JSON.stringify(d, null, 2))).then(() => toast("success", t("common.copied"))).catch(fail)}>{t("settings.copyDiagnostics")}</button>
          <button className="btn" onClick={() => boot && api.openPath(boot.dataDir).catch(fail)}><FolderOpen size={16} /> {t("settings.openDataDir")}</button>
        </Row>
        {diag && (
          <div className="setting">
            <div className="kv" style={{ width: "100%" }}>
              <div className="k">{t("common.series")}</div><div className="v">{diag.series}</div>
              <div className="k">{t("common.episodes")}</div><div className="v">{diag.episodes}</div>
              <div className="k">{t("nav.unsorted")}</div><div className="v">{diag.unsorted}</div>
              <div className="k">{t("nav.unavailable")}</div><div className="v">{diag.unavailable}</div>
              <div className="k">WebView2</div><div className="v">{diag.webviewVersion}</div>
            </div>
          </div>
        )}
      </Section>
      <Section title={t("settings.telemetry")}>
        <Row label={t("settings.telemetry")} desc={t("settings.telemetryText")}><Tog k="telemetry" /></Row>
        <Row label={t("settings.resetAll")}>
          <button className="btn danger" onClick={() => openDialog(<Confirm title={t("settings.resetAll")} text={t("settings.resetAll") + "?"} danger onConfirm={async () => { const s = await api.resetSettings(); await updateSettings({ ...s, libraryPath: settings.libraryPath }); }} />)}>
            <RotateCcw size={16} /> {t("settings.resetAll")}
          </button>
        </Row>
      </Section>
    </>
  );
}

function LogsDialog() {
  const { closeDialog } = useStore();
  const [text, setText] = useState("");
  useEffect(() => {
    api.readLogs().then((l) => setText(l || "–"));
  }, []);
  return (
    <Modal title={t("settings.logs")} onClose={closeDialog} size="xwide">
      <div className="logbox" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>{text}</div>
    </Modal>
  );
}

function About() {
  const { boot } = useStore();
  return (
    <Section title="NEXUS ANIME">
      <div className="setting" style={{ gap: 18 }}>
        <div className="logo-mark" style={{ width: 56, height: 56, fontSize: 26, borderRadius: 16 }}>N</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>NEXUS ANIME</div>
          <div className="hint">{t("settings.version", { v: boot?.version ?? "" })}</div>
        </div>
      </div>
      <Row label={t("settings.about")} desc={t("settings.aboutText")} />
      <Row label={t("settings.metadata")} desc={t("settings.metadataSource")} />
      <Row label={t("player.subtitles")} desc={<><Film size={12} /> {t("settings.codecInfo")}</>} />
    </Section>
  );
}

export function SettingsPage() {
  const { route, navigate } = useStore();
  const cat = (route.params?.cat as Cat) ?? "general";
  return (
    <div className="page">
      <div className="page-head"><h1 className="page-title">{t("settings.title")}</h1></div>
      <div className="settings">
        <nav className="settings-nav">
          {CATS.map((c) => (
            <button key={c.id} className={cat === c.id ? "active" : ""} onClick={() => navigate({ name: "settings", params: { cat: c.id } })}>
              {c.icon} {t(c.label)}
            </button>
          ))}
        </nav>
        <div className="settings-body" key={cat}>
          {cat === "general" && <General />}
          {cat === "library" && <LibrarySettings />}
          {cat === "files" && <Files />}
          {cat === "playback" && <Playback />}
          {cat === "links" && <LinkSources />}
          {cat === "metadata" && <Metadata />}
          {cat === "plugins" && <PluginSettings />}
          {cat === "data" && <Data />}
          {cat === "about" && <About />}
        </div>
      </div>
    </div>
  );
}
