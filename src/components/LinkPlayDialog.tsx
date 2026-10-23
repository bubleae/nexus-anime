import { useState } from "react";
import { Globe, Play } from "lucide-react";
import { Episode, Series } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { Modal } from "./ui";
import { resolveLink } from "../player/linkSources";

/**
 * Folge wählen und über die Link-Quellen abspielen – auch für Folgen ohne Datei.
 * Ohne `series` (z. B. von „Entdecken“) wird nur der eingegebene Titel verwendet.
 */
export function LinkPlayDialog({ series, episodes = [], title }: { series?: Series; episodes?: Episode[]; title?: string }) {
  const { closeDialog, playStream, navigate } = useStore();
  const name = series?.title ?? title ?? "";
  const seasons = [...new Set(episodes.filter((e) => e.kind === "episode").map((e) => e.season ?? 1))].sort((a, b) => a - b);
  const [season, setSeason] = useState(seasons[0] ?? 1);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inSeason = episodes.filter((e) => e.kind === "episode" && (e.season ?? 1) === season && e.episode != null);
  const known = new Map(inSeason.map((e) => [e.episode!, e]));
  const count = Math.max(season === 1 && seasons.length <= 1 ? series?.totalEpisodes ?? 0 : 0, ...known.keys(), series ? 12 : 24);

  const play = async (n: number) => {
    setBusy(n);
    setError(null);
    try {
      const r = await resolveLink(
        { title: name, altTitle: series?.altTitle ?? null, season, episode: n, anilistId: series?.anilistId ?? null },
        series?.id ?? null,
        known.get(n)?.title,
      );
      if (r.spec) playStream(r.spec);
      else setError(`${t("links.notFound")}:\n${r.tried.join("\n") || t("links.noneActive")}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const customNumber = Number(custom);
  const customValid = Number.isInteger(customNumber) && customNumber > 0;

  return (
    <Modal
      title={t("links.pickTitle")}
      subtitle={name}
      size="wide"
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={() => { closeDialog(); navigate({ name: "settings", params: { cat: "links" } }); }}>{t("links.manage")}</button>
          <button className="btn" onClick={closeDialog}>{t("common.cancel")}</button>
        </>
      }
    >
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "0 0 140px" }}>
          <label>{t("common.season")}</label>
          <input className="input" type="number" min={1} value={season} onChange={(e) => setSeason(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div className="field" style={{ flex: "0 0 140px" }}>
          <label>{t("links.otherEpisode")}</label>
          <input className="input" type="number" min={1} value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && customValid && play(customNumber)} />
        </div>
        <div className="field" style={{ flex: "0 0 auto" }}>
          <button className="btn primary" disabled={!customValid || busy != null} onClick={() => play(customNumber)}><Play size={15} /> {t("player.play")}</button>
        </div>
      </div>
      <div className="label" style={{ margin: "6px 0 8px" }}>{t("links.pickEpisode")}</div>
      <div className="link-ep-grid">
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            className={`link-ep ${known.get(n)?.watched ? "watched" : ""}`}
            title={known.get(n)?.title ?? undefined}
            disabled={busy != null}
            onClick={() => play(n)}
          >
            {busy === n ? <div className="spinner" /> : n}
          </button>
        ))}
      </div>
      {busy != null && <div className="hint" style={{ marginTop: 10 }}><Globe size={13} /> {t("links.searching")}</div>}
      {error && <div className="plugin-error" style={{ margin: "12px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{error}</div>}
    </Modal>
  );
}
