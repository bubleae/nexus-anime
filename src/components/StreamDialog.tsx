import { useState } from "react";
import { Play, Radio, X } from "lucide-react";
import { useStore } from "../store";
import { t } from "../i18n";
import { relativeTime } from "../format";
import { Modal } from "./ui";
import { forgetStream, normalizeStreamUrl, recentStreams, rememberStream } from "../player/stream";

/** Dialog zum Abspielen eines eigenen Stream-Links (Jellyfin, Plex, NAS …). */
export function StreamDialog() {
  const { closeDialog, playStream } = useStore();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [sub, setSub] = useState("");
  const [recent, setRecent] = useState(recentStreams);
  const [error, setError] = useState<string | null>(null);

  const start = (u: string, name?: string, subUrl?: string) => {
    try {
      const clean = normalizeStreamUrl(u);
      if (subUrl?.trim()) normalizeStreamUrl(subUrl);
      rememberStream({ url: clean, title: name?.trim() || undefined, subtitleUrl: subUrl?.trim() || undefined, at: Date.now() });
      playStream({ url: clean, title: name?.trim() || undefined, subtitles: subUrl?.trim() ? [{ url: subUrl.trim() }] : undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      title={t("stream.title")}
      subtitle={t("stream.text")}
      size="wide"
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={!url.trim()} onClick={() => start(url, title, sub)}>
            <Play size={16} /> {t("stream.play")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("stream.url")}</label>
        <input
          className="input"
          autoFocus
          value={url}
          placeholder={t("stream.urlPlaceholder")}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && url.trim() && start(url, title, sub)}
        />
      </div>
      <div className="row">
        <div className="field">
          <label>{t("stream.name")}</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label>{t("stream.subtitleUrl")}</label>
          <input className="input" value={sub} onChange={(e) => setSub(e.target.value)} />
        </div>
      </div>
      {error && <div className="plugin-error" style={{ margin: "0 0 12px" }}>{error}</div>}
      <div className="hint" style={{ fontSize: 12.5, lineHeight: 1.55 }}>{t("stream.formats")}</div>

      {recent.length > 0 && (
        <div className="stream-recent">
          <div className="label" style={{ margin: "18px 0 8px" }}>{t("stream.recent")}</div>
          {recent.map((r) => (
            <div key={r.url} className="stream-item" onClick={() => start(r.url, r.title, r.subtitleUrl)}>
              <Radio size={16} />
              <div className="grow">
                <div className="t">{r.title || r.url}</div>
                <div className="u">{r.title ? r.url : relativeTime(new Date(r.at).toISOString())}</div>
              </div>
              <button
                className="icon-btn"
                title={t("stream.remove")}
                onClick={(e) => {
                  e.stopPropagation();
                  forgetStream(r.url);
                  setRecent(recentStreams());
                }}
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

