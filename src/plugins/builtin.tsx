// Eingebaute Plugins. Sie nutzen dieselbe `nexus`-API wie selbst geschriebene Plugins
// und lassen sich unter Einstellungen → Plugins einzeln an- und ausschalten.
import { useEffect, useState } from "react";
import type { Episode, Series } from "../api";
import type { BuiltinPlugin, Nexus } from "./host";

// ---------------------------------------------------------------------------
// Statistiken
// ---------------------------------------------------------------------------

type Stats = {
  series: number;
  episodes: number;
  watched: number;
  watchedSeconds: number;
  librarySize: number;
  genres: [string, number][];
  top: { id: string; title: string; watched: number; total: number }[];
  months: { month: string; n: number }[];
};

async function loadStats(nexus: Nexus): Promise<Stats> {
  const q = nexus.db.query;
  const [totals] = await q<any[]>(
    `SELECT COUNT(*) AS episodes, SUM(watched) AS watched,
            SUM(CASE WHEN watched = 1 THEN COALESCE(duration, 0) ELSE position END) AS secs,
            SUM(file_size) AS size
       FROM episodes WHERE ignored = 0`,
  );
  const top = await q<any[]>(
    `SELECT s.id, s.title, SUM(e.watched) AS seen, COUNT(*) AS total
       FROM episodes e JOIN series s ON s.id = e.series_id
      WHERE e.ignored = 0 GROUP BY s.id HAVING SUM(e.watched) > 0 ORDER BY seen DESC LIMIT 8`,
  );
  const months = await q<any[]>(
    `SELECT substr(watched_at, 1, 7) AS month, COUNT(*) AS n FROM episodes
      WHERE watched = 1 AND watched_at IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 12`,
  );
  const series = nexus.library.series();
  const g = new Map<string, number>();
  series.forEach((s) => s.genres.forEach((x) => g.set(x, (g.get(x) ?? 0) + 1)));
  return {
    series: series.length,
    episodes: totals?.episodes ?? 0,
    watched: totals?.watched ?? 0,
    watchedSeconds: totals?.secs ?? 0,
    librarySize: totals?.size ?? 0,
    genres: [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    top: top.map((x) => ({ id: x.id, title: x.title, watched: x.seen, total: x.total })),
    months: months.reverse(),
  };
}

function StatsPage({ nexus }: { nexus: Nexus }) {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadStats(nexus).then(setS).catch((e) => setErr(String(e)));
  }, []);
  const t = nexus.utils.t;
  if (err) return <div className="page"><div className="plugin-error">{err}</div></div>;
  if (!s) return <div className="loading-page"><div className="spinner lg" /></div>;
  const hours = s.watchedSeconds / 3600;
  const maxMonth = Math.max(1, ...s.months.map((m) => m.n));
  const maxGenre = Math.max(1, ...s.genres.map((g) => g[1]));
  return (
    <div className="page">
      <div className="page-head"><h1 className="page-title">{t("plugin.stats.title")}</h1></div>
      <div className="stat-tiles">
        <div className="stat-tile"><div className="v">{s.series}</div><div className="k">{t("plugin.stats.series")}</div></div>
        <div className="stat-tile"><div className="v">{s.episodes}</div><div className="k">{t("plugin.stats.episodes")}</div></div>
        <div className="stat-tile"><div className="v">{s.watched}</div><div className="k">{t("plugin.stats.watched")}</div></div>
        <div className="stat-tile">
          <div className="v">{hours >= 48 ? `${(hours / 24).toLocaleString("de-DE", { maximumFractionDigits: 1 })} d` : `${hours.toLocaleString("de-DE", { maximumFractionDigits: 1 })} h`}</div>
          <div className="k">{t("plugin.stats.time")}</div>
        </div>
        <div className="stat-tile"><div className="v">{nexus.utils.formatBytes(s.librarySize)}</div><div className="k">{t("plugin.stats.size")}</div></div>
      </div>
      <div className="stat-grid">
        <div className="settings-section">
          <h3>{t("plugin.stats.top")}</h3>
          {s.top.length === 0 && <div className="hint">{t("plugin.stats.none")}</div>}
          {s.top.map((x) => (
            <div key={x.id} className="stat-row clickable" onClick={() => nexus.ui.openSeries(x.id)}>
              <span className="grow">{x.title}</span>
              <span className="hint">{x.watched} / {x.total}</span>
              <div className="stat-bar"><div style={{ width: `${(x.watched / Math.max(1, x.total)) * 100}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="settings-section">
          <h3>{t("plugin.stats.genres")}</h3>
          {s.genres.length === 0 && <div className="hint">{t("plugin.stats.none")}</div>}
          {s.genres.map(([g, n]) => (
            <div key={g} className="stat-row clickable" onClick={() => nexus.ui.navigate("library", { genre: g })}>
              <span className="grow">{g}</span>
              <span className="hint">{n}</span>
              <div className="stat-bar"><div style={{ width: `${(n / maxGenre) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
      {s.months.length > 0 && (
        <div className="settings-section">
          <h3>{t("plugin.stats.months")}</h3>
          <div className="stat-months">
            {s.months.map((m) => (
              <div key={m.month} className="col" title={`${m.month}: ${m.n}`}>
                <div className="bar" style={{ height: `${(m.n / maxMonth) * 100}%` }} />
                <span>{m.month.slice(5)}/{m.month.slice(2, 4)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const stats: BuiltinPlugin = {
  manifest: {
    id: "builtin.stats",
    name: "Statistiken",
    version: "1.0.0",
    description: "Seite mit Zahlen zu deiner Bibliothek: angesehene Folgen, Zeit, Lieblingsgenres und Verlauf nach Monaten.",
    defaultEnabled: true,
    settings: [{ key: "nav", label: "In der Hauptnavigation anzeigen", type: "boolean", default: false, description: "Sonst unter „Mehr“." }],
  },
  activate(nexus) {
    nexus.ui.addPage({
      id: "stats",
      title: nexus.utils.t("plugin.stats.title"),
      icon: "📊",
      nav: nexus.config.get<boolean>("nav") ? "top" : "more",
      render: () => <StatsPage nexus={nexus} />,
    });
  },
};

// ---------------------------------------------------------------------------
// Zufallsfolge
// ---------------------------------------------------------------------------

const pick = <T,>(list: T[]): T | null => (list.length ? list[Math.floor(Math.random() * list.length)] : null);

const random: BuiltinPlugin = {
  manifest: {
    id: "builtin.random",
    name: "Zufallsfolge",
    version: "1.0.0",
    description: "„Überrasch mich“: spielt eine zufällige ungesehene Folge. Mit Knopf auf der Startseite, Eintrag im Serienmenü und Taste Z.",
    defaultEnabled: false,
  },
  activate(nexus) {
    const t = nexus.utils.t;
    const playable = (e: Episode) => e.available && !e.missing;
    const surprise = async () => {
      const list = (await nexus.library.episodes("unwatched", 500)).filter(playable);
      const e = pick(list);
      if (!e) return nexus.ui.toast("info", t("plugin.random.none"));
      nexus.ui.toast("success", t("plugin.random.playing"), `${e.seriesTitle ?? ""} · ${nexus.utils.episodeCode(e)}`);
      nexus.ui.play(e.id);
    };
    nexus.ui.addHomeSection({
      id: "surprise",
      position: "top",
      render: () => (
        <div className="banner-note">
          <div className="ic">🎲</div>
          <div className="grow">{t("plugin.random.text")}</div>
          <button className="btn small primary" onClick={surprise}>{t("plugin.random.button")}</button>
        </div>
      ),
    });
    nexus.ui.addSeriesMenuItem({
      label: t("plugin.random.series"),
      icon: "🎲",
      onClick: async (s: Series) => {
        const d = await nexus.library.detail(s.id);
        const e = pick(d.episodes.filter((x) => playable(x) && !x.watched)) ?? pick(d.episodes.filter(playable));
        if (e) nexus.ui.play(e.id);
        else nexus.ui.toast("info", t("plugin.random.none"));
      },
    });
    nexus.ui.addShortcut({ key: "z", run: surprise });
  },
};

// ---------------------------------------------------------------------------
// Folgenliste kopieren
// ---------------------------------------------------------------------------

const episodeList: BuiltinPlugin = {
  manifest: {
    id: "builtin.episode-list",
    name: "Folgenliste kopieren",
    version: "1.0.0",
    description: "Kopiert die Folgen einer Serie als Textliste (mit Status ✓ angesehen) in die Zwischenablage.",
    defaultEnabled: false,
  },
  activate(nexus) {
    const { episodeCode, episodeTitle, t } = nexus.utils;
    nexus.ui.addSeriesMenuItem({
      label: t("plugin.list.copy"),
      icon: "📋",
      onClick: async (s) => {
        const d = await nexus.library.detail(s.id);
        const lines = d.episodes.map((e) => `${e.watched ? "✓" : "○"} ${episodeCode(e)}  ${episodeTitle(e)}`);
        await navigator.clipboard.writeText(`${s.title}\n${"=".repeat(s.title.length)}\n${lines.join("\n")}\n`);
        nexus.ui.toast("success", t("common.copied"), t("plugin.list.count", { n: lines.length }));
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Eigenes CSS (Themes)
// ---------------------------------------------------------------------------

function CssEditor({ nexus, apply }: { nexus: Nexus; apply: (css: string) => void }) {
  const [css, setCss] = useState(nexus.storage.get<string>("css", ""));
  const t = nexus.utils.t;
  return (
    <div className="field" style={{ width: "100%" }}>
      <label>{t("plugin.css.label")}</label>
      <textarea
        className="input code"
        rows={8}
        spellCheck={false}
        value={css}
        placeholder={":root { --accent: #e11d48; }\n.topnav { backdrop-filter: none; }"}
        onChange={(e) => setCss(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn small primary" onClick={() => { apply(css); nexus.storage.set("css", css); nexus.ui.toast("success", t("settings.saved")); }}>{t("common.apply")}</button>
        <button className="btn small ghost" onClick={() => { setCss(""); apply(""); nexus.storage.remove("css"); }}>{t("plugin.css.clear")}</button>
      </div>
    </div>
  );
}

const customCss: BuiltinPlugin = {
  manifest: {
    id: "builtin.custom-css",
    name: "Eigenes CSS",
    version: "1.0.0",
    description: "Eigene Farben und Stile für die ganze App – z. B. für ein eigenes Theme. Bearbeitung direkt hier in den Einstellungen.",
    defaultEnabled: false,
  },
  activate(nexus) {
    let remove: (() => void) | null = null;
    const apply = (css: string) => {
      remove?.();
      remove = css.trim() ? nexus.ui.addStyle(css) : null;
    };
    apply(nexus.storage.get<string>("css", ""));
    nexus.ui.addSettings({ render: () => <CssEditor nexus={nexus} apply={apply} /> });
  },
};

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [stats, random, episodeList, customCss];
