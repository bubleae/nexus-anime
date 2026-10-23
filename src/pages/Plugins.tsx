import { ReactNode, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, BookOpen, FileCode2, FolderOpen, FolderPlus, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { api, PluginSettingField } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { Confirm, Empty, Modal, Switch } from "../components/ui";
import { PromptDialog } from "../components/dialogs";
import { getPluginConfig, getPluginsDir, PluginStatus, PluginView, reloadPlugins, setPluginConfig, setPluginEnabled, usePlugins } from "../plugins/host";
import PLUGIN_GUIDE from "../../PLUGINS.md?raw";

/** Seite eines Plugins (Route „plugin“). */
export function PluginPage({ plugin, page, params }: { plugin: string; page: string; params: Record<string, string> }) {
  const { registry } = usePlugins();
  const { navigate } = useStore();
  const p = registry.pages.find((x) => x.pluginId === plugin && x.id === page);
  if (!p)
    return (
      <Empty icon={<Puzzle size={30} />} title={t("plugins.pageMissing")} text={t("plugins.pageMissingText")}>
        <button className="btn" onClick={() => navigate({ name: "settings", params: { cat: "plugins" } })}>{t("plugins.title")}</button>
      </Empty>
    );
  return <PluginView pluginId={plugin} spec={p} ctx={{ params }} />;
}

function ConfigField({ pluginId, f }: { pluginId: string; f: PluginSettingField }) {
  const { fail } = useStore();
  const cur = getPluginConfig(pluginId)[f.key] ?? f.default;
  const [text, setText] = useState(cur == null ? "" : String(cur));
  const set = (v: unknown) => setPluginConfig(pluginId, f.key, v).then(() => reloadPlugins()).catch(fail);
  const opts = (f.options ?? []).map((o) => (Array.isArray(o) ? o : [o, o])) as [string, string][];
  let ctrl: ReactNode;
  if (f.type === "boolean") ctrl = <Switch checked={!!cur} onChange={set} />;
  else if (f.type === "select")
    ctrl = (
      <select className="select" value={String(cur ?? "")} onChange={(e) => set(e.target.value)}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  else if (f.type === "text")
    ctrl = <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => set(text)} />;
  else
    ctrl = (
      <input
        className="input"
        type={f.type === "number" ? "number" : "text"}
        value={text}
        style={{ width: 240 }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => set(f.type === "number" ? Number(text) : text)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    );
  return (
    <div className={`setting ${f.type === "text" ? "col" : ""}`}>
      <div className="s-text">
        <div className="s-label">{f.label}</div>
        {f.description && <div className="s-desc">{f.description}</div>}
      </div>
      <div className="s-ctrl">{ctrl}</div>
    </div>
  );
}

function PluginCard({ p }: { p: PluginStatus }) {
  const { registry } = usePlugins();
  const { fail, toast, openDialog, navigate } = useStore();
  const [busy, setBusy] = useState(false);
  const panels = registry.settings.filter((s) => s.pluginId === p.id);
  const pages = registry.pages.filter((s) => s.pluginId === p.id);
  const fields = p.manifest.settings ?? [];
  const toggle = async (v: boolean) => {
    setBusy(true);
    try {
      await setPluginEnabled(p.id, v);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`plugin-card ${p.enabled ? "on" : ""}`}>
      <div className="plugin-head">
        <div className="plugin-ic">{p.builtin ? <Puzzle size={20} /> : p.runtime === "python" ? <span className="py-ic">Py</span> : <FileCode2 size={20} />}</div>
        <div className="grow">
          <div className="plugin-name">
            {p.name}
            {p.version && <span className="hint"> {p.version}</span>}
            <span className={`tag ${p.runtime}`}>{p.runtime === "builtin" ? t("plugins.builtin") : p.runtime === "python" ? "Python" : "JavaScript"}</span>
          </div>
          {p.description && <div className="s-desc">{p.description}</div>}
          {(p.author || !p.builtin) && <div className="hint" style={{ fontSize: 12 }}>{[p.author, !p.builtin && p.id].filter(Boolean).join(" · ")}</div>}
        </div>
        <Switch checked={p.enabled} disabled={busy} onChange={toggle} />
      </div>
      {p.error && (
        <div className="plugin-error">
          <AlertTriangle size={15} /> <span>{p.error}</span>
        </div>
      )}
      {p.active && (fields.length > 0 || panels.length > 0) && (
        <div className="plugin-body">
          {fields.map((f) => <ConfigField key={f.key} pluginId={p.id} f={f} />)}
          {panels.map((s) => (
            <div key={s.uid} className="setting col">
              <PluginView pluginId={p.id} spec={s} ctx={{}} />
            </div>
          ))}
        </div>
      )}
      {(pages.length > 0 || !p.builtin) && (
        <div className="plugin-actions">
          {pages.map((pg) => (
            <button key={pg.uid} className="btn small" onClick={() => navigate({ name: "plugin", params: { plugin: p.id, page: pg.id } })}>{pg.title}</button>
          ))}
          {!p.builtin && p.dir && (
            <>
              <button className="btn small ghost" onClick={() => api.openPath(p.dir!).catch(fail)}><FolderOpen size={14} /> {t("plugins.openFolder")}</button>
              <button
                className="btn small ghost danger-text"
                onClick={() =>
                  openDialog(
                    <Confirm
                      title={t("plugins.uninstall")}
                      text={t("plugins.uninstallText", { p: p.name })}
                      danger
                      confirmLabel={t("plugins.uninstall")}
                      onConfirm={async () => {
                        await api.pluginUninstall(p.id);
                        await reloadPlugins();
                        toast("success", t("plugins.uninstalled"), p.name);
                      }}
                    />,
                  )
                }
              >
                <Trash2 size={14} /> {t("plugins.uninstall")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GuideDialog() {
  const { closeDialog, toast } = useStore();
  return (
    <Modal title={t("plugins.guide")} onClose={closeDialog} size="xwide">
      <div className="plugin-guide">{PLUGIN_GUIDE}</div>
      <div style={{ marginTop: 12 }}>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(PLUGIN_GUIDE).then(() => toast("success", t("common.copied")))}>{t("plugins.copyGuide")}</button>
      </div>
    </Modal>
  );
}

export function PluginSettings() {
  const { statuses } = usePlugins();
  const { fail, toast, openDialog } = useStore();
  const [reloading, setReloading] = useState(false);
  const builtin = statuses.filter((p) => p.builtin);
  const external = statuses.filter((p) => !p.builtin);

  const reload = async () => {
    setReloading(true);
    try {
      await reloadPlugins();
      toast("success", t("plugins.reloaded"));
    } catch (e) {
      fail(e);
    } finally {
      setReloading(false);
    }
  };
  const install = async (folder: boolean) => {
    const picked = folder ? await open({ directory: true }) : await open({ filters: [{ name: "Plugin (JavaScript/Python)", extensions: ["js", "mjs", "py"] }] });
    if (!picked || Array.isArray(picked)) return;
    try {
      const id = await api.pluginInstall(picked);
      await api.pluginSetEnabled(id, true);
      await reloadPlugins();
      toast("success", t("plugins.installed"), id);
    } catch (e) {
      fail(e);
    }
  };
  const create = (lang: "js" | "py") =>
    openDialog(
      <PromptDialog
        title={lang === "py" ? t("plugins.createPy") : t("plugins.create")}
        label={t("plugins.createLabel")}
        initial={t("plugins.createDefault")}
        onSubmit={async (name) => {
          const id = await api.pluginCreate(name, lang);
          await reloadPlugins();
          toast("success", t("plugins.created"), id);
          const dir = getPluginsDir();
          if (dir) api.openPath(`${dir}\\${id}`).catch(() => {});
        }}
      />,
    );

  return (
    <>
      <div className="settings-section">
        <h3>{t("plugins.title")}</h3>
        <div className="desc">{t("plugins.text")}</div>
        <div className="plugin-toolbar">
          <button className="btn primary small" onClick={() => create("js")}><Plus size={15} /> {t("plugins.create")}</button>
          <button className="btn primary small" onClick={() => create("py")}><Plus size={15} /> {t("plugins.createPy")}</button>
          <button className="btn small" onClick={() => install(true)}><FolderPlus size={15} /> {t("plugins.installFolder")}</button>
          <button className="btn small" onClick={() => install(false)}><FileCode2 size={15} /> {t("plugins.installFile")}</button>
          <button className="btn small" disabled={reloading} onClick={reload}><RefreshCw size={15} className={reloading ? "spin-icon" : ""} /> {t("plugins.reload")}</button>
          <button className="btn small ghost" onClick={() => getPluginsDir() && api.openPath(getPluginsDir()).catch(fail)}><FolderOpen size={15} /> {t("plugins.openDir")}</button>
          <button className="btn small ghost" onClick={() => openDialog(<GuideDialog />)}><BookOpen size={15} /> {t("plugins.guide")}</button>
        </div>
        <div className="plugin-warning"><AlertTriangle size={15} /> {t("plugins.warning")}</div>
      </div>

      <div className="settings-section">
        <h3>{t("plugins.installedTitle")}</h3>
        {external.length === 0 ? (
          <div className="hint" style={{ padding: "8px 0" }}>{t("plugins.noneInstalled", { d: getPluginsDir() })}</div>
        ) : (
          external.map((p) => <PluginCard key={p.id} p={p} />)
        )}
      </div>

      <div className="settings-section">
        <h3>{t("plugins.builtinTitle")}</h3>
        {builtin.map((p) => <PluginCard key={p.id} p={p} />)}
      </div>
    </>
  );
}
