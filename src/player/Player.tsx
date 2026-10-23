// Integrierter Videoplayer: streamt die Originaldatei über nexus://video/<id> (HTTP-Range),
// speichert regelmäßig die Position, unterstützt Untertitel (extern + MKV-eingebettet), Audiospuren,
// Geschwindigkeit, Vollbild, Tastatur- und Maussteuerung sowie automatische nächste Folge.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle, ArrowLeft, Captions, Check, ExternalLink, FolderInput, Gauge, Languages, Maximize, Minimize, Pause, Play,
  RotateCcw, RotateCw, SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from "lucide-react";
import { api, errorText, imageUrl, PlaybackInfo, SubtitleTrack, videoUrl } from "../api";
import { useStore } from "../store";
import { t } from "../i18n";
import { episodeCode, episodeTitle, formatDuration } from "../format";
import { emit, handlePluginShortcut, iconNode, PlayerControls, setPlayer, usePlugins } from "../plugins/host";

type AudioTrackLike = { id: string; label: string; language: string; enabled: boolean };
type Menu = null | "subs" | "audio" | "speed";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function Player({ episodeId }: { episodeId: string }) {
  const { settings, closePlayer, play, fail, toast } = useStore();
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(settings.defaultVolume);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(settings.defaultSpeed);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [osd, setOsd] = useState<string | null>(null);
  const [flash, setFlash] = useState<"play" | "pause" | null>(null);
  const [subTrack, setSubTrack] = useState<string | null>(null);
  const [subUrl, setSubUrl] = useState<string | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [extraSubs, setExtraSubs] = useState<{ id: string; label: string; vtt: string }[]>([]);
  const [audioTracks, setAudioTracks] = useState<AudioTrackLike[]>([]);
  const [resumeOffer, setResumeOffer] = useState<number | null>(null);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [seekHover, setSeekHover] = useState<{ x: number; t: number } | null>(null);
  const [seekDrag, setSeekDrag] = useState(false);
  const lastSaved = useRef(0);
  const idleTimer = useRef<number | undefined>(undefined);
  const osdTimer = useRef<number | undefined>(undefined);
  const markedWatched = useRef(false);
  const { registry } = usePlugins();
  const controls = useRef<PlayerControls | null>(null);

  // ---------- Laden ----------
  useEffect(() => {
    setInfo(null);
    setLoadError(null);
    setMediaError(null);
    setEnded(false);
    setCountdown(null);
    setResumeOffer(null);
    setResumedAt(null);
    setSubTrack(null);
    setSubUrl(null);
    setExtraSubs([]);
    setWaiting(true);
    markedWatched.current = false;
    api.playback(episodeId).then(setInfo).catch((e) => setLoadError(errorText(e)));
  }, [episodeId]);

  // Fenster-Vollbild gemäß Einstellung
  useEffect(() => {
    if (settings.playerWindowMode === "fullscreen") setFs(true);
    return () => {
      getCurrentWindow().setFullscreen(false).catch(() => {});
    };
  }, []);

  const setFs = useCallback(async (v: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(v);
      setFullscreen(v);
    } catch {
      /* ignorieren */
    }
  }, []);

  const showOsd = (text: string) => {
    setOsd(text);
    clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsd(null), 1400);
  };

  // ---------- Fortschritt speichern ----------
  const save = useCallback(
    (finished = false) => {
      const v = video.current;
      if (!v || !info || mediaError) return;
      const pos = v.currentTime;
      if (!finished && pos < 3) return;
      api.saveProgress(info.episode.id, pos, isFinite(v.duration) ? v.duration : null, finished)
        .then((watched) => {
          if (watched && !markedWatched.current) {
            markedWatched.current = true;
            emit("episode:watched", { episode: { ...info.episode, watched: true }, series: info.series });
          }
        })
        .catch(() => {});
      lastSaved.current = Date.now();
    },
    [info, mediaError],
  );
  useEffect(() => () => save(), [save]);
  useEffect(() => {
    const h = () => save();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [save]);

  // ---------- Plugins ----------
  useEffect(() => {
    if (!info) return;
    const ctx = { episode: info.episode, series: info.series, video: video.current };
    setPlayer({
      ctx,
      controls: {
        play: () => controls.current?.play(),
        pause: () => controls.current?.pause(),
        seek: (s) => controls.current?.seek(s),
        next: () => controls.current?.next(),
        previous: () => controls.current?.previous(),
        close: () => controls.current?.close(),
        osd: (text) => controls.current?.osd(text),
      },
    });
    emit("player:open", { episode: info.episode, series: info.series });
    return () => {
      const v = video.current;
      setPlayer(null);
      emit("player:close", { episode: info.episode, series: info.series, time: v?.currentTime ?? 0, duration: v && isFinite(v.duration) ? v.duration : null });
    };
  }, [info]);

  // ---------- Untertitel ----------
  const subtitles: SubtitleTrack[] = info?.subtitles ?? [];
  const loadSub = useCallback(
    async (id: string | null) => {
      setMenu(null);
      if (subUrl) URL.revokeObjectURL(subUrl);
      setSubUrl(null);
      setSubTrack(id);
      if (!id || !info) return;
      try {
        let vtt: string;
        const extra = extraSubs.find((x) => x.id === id);
        if (extra) vtt = extra.vtt;
        else {
          setSubLoading(true);
          vtt = await api.subtitle(info.episode.id, id);
        }
        setSubUrl(URL.createObjectURL(new Blob([vtt], { type: "text/vtt" })));
      } catch (e) {
        toast("error", t("player.subtitleError"), errorText(e));
        setSubTrack(null);
      } finally {
        setSubLoading(false);
      }
    },
    [info, extraSubs, subUrl, toast],
  );
  // Bevorzugte Untertitelsprache automatisch wählen
  useEffect(() => {
    if (!info) return;
    const pref = settings.preferredSubtitleLang;
    const supported = info.subtitles.filter((s) => s.supported);
    const match =
      supported.find((s) => pref && s.language?.toLowerCase().startsWith(pref.slice(0, 2))) ??
      supported.find((s) => s.source === "external" && !pref) ??
      null;
    if (match) loadSub(match.id);
  }, [info]);
  // Untertitel selbst darstellen (Spur „hidden“), damit sie über der Steuerleiste stehen und gestylt werden können
  const cueBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const v = video.current;
    if (cueBox.current) cueBox.current.replaceChildren();
    if (!v || !subUrl) return;
    let track: TextTrack | null = null;
    const render = () => {
      const box = cueBox.current;
      if (!box || !track) return;
      box.replaceChildren();
      const cues = track.activeCues;
      if (!cues) return;
      for (let i = 0; i < cues.length; i++) {
        const line = document.createElement("div");
        line.className = "cue-line";
        line.appendChild((cues[i] as VTTCue).getCueAsHTML());
        box.appendChild(line);
      }
    };
    const attach = () => {
      track = v.textTracks[0] ?? null;
      if (!track) return;
      track.mode = "hidden";
      track.addEventListener("cuechange", render);
      render();
    };
    const id = window.setTimeout(attach, 50);
    return () => {
      clearTimeout(id);
      track?.removeEventListener("cuechange", render);
    };
  }, [subUrl]);

  const loadExternalSub = async () => {
    setMenu(null);
    const file = await open({ multiple: false, filters: [{ name: "Untertitel", extensions: ["srt", "ass", "ssa", "vtt"] }] });
    if (!file || Array.isArray(file)) return;
    try {
      const vtt = await api.loadSubtitleFile(file);
      const id = `user:${Date.now()}`;
      const label = file.split(/[\\/]/).pop() ?? file;
      setExtraSubs((x) => [...x, { id, label, vtt }]);
      if (subUrl) URL.revokeObjectURL(subUrl);
      setSubTrack(id);
      setSubUrl(URL.createObjectURL(new Blob([vtt], { type: "text/vtt" })));
    } catch (e) {
      fail(e);
    }
  };

  // ---------- Audiospuren (WebView2 mit AudioVideoTracks) ----------
  const readAudioTracks = () => {
    const v = video.current as any;
    const list = v?.audioTracks;
    if (!list || list.length === undefined) return setAudioTracks([]);
    const tracks: AudioTrackLike[] = [];
    for (let i = 0; i < list.length; i++) tracks.push({ id: String(i), label: list[i].label, language: list[i].language, enabled: list[i].enabled });
    setAudioTracks(tracks);
    const pref = settings.preferredAudioLang;
    if (pref && tracks.length > 1) {
      const idx = tracks.findIndex((tr) => tr.language?.toLowerCase().startsWith(pref.slice(0, 2)) || (pref === "ger" && tr.language === "deu"));
      if (idx >= 0 && !tracks[idx].enabled) selectAudio(idx);
    }
  };
  const selectAudio = (idx: number) => {
    const list = (video.current as any)?.audioTracks;
    if (!list) return;
    const t0 = video.current!.currentTime;
    for (let i = 0; i < list.length; i++) list[i].enabled = i === idx;
    video.current!.currentTime = t0;
    readAudioTracks();
    setMenu(null);
  };

  // ---------- Steuerung ----------
  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v || mediaError) return;
    if (v.paused) {
      v.play().catch(() => {});
      setFlash("play");
    } else {
      v.pause();
      setFlash("pause");
      save();
    }
    setTimeout(() => setFlash(null), 600);
  }, [mediaError, save]);

  const seekBy = (d: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min((v.duration || 0) - 0.5, v.currentTime + d));
    showOsd(`${d > 0 ? "+" : "−"}${Math.abs(d)} s`);
  };
  const changeVolume = (d: number) => {
    const nv = Math.max(0, Math.min(1, Math.round((volume + d) * 100) / 100));
    setVolume(nv);
    setMuted(false);
    showOsd(`${t("settings.volume").split(" ").pop()}: ${Math.round(nv * 100)} %`);
  };
  const changeSpeed = (s: number) => {
    setSpeed(s);
    setMenu(null);
    showOsd(`${s.toLocaleString("de-DE")}×`);
  };
  useEffect(() => {
    if (video.current) {
      video.current.volume = volume;
      video.current.muted = muted;
    }
  }, [volume, muted]);
  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);

  const goNext = useCallback(() => {
    if (!info?.nextId) return;
    save(true);
    play(info.nextId);
  }, [info, play, save]);
  const goPrev = () => {
    if (!info?.previousId) return;
    save();
    play(info.previousId);
  };
  const close = useCallback(() => {
    save();
    setFs(false);
    closePlayer();
  }, [save, closePlayer, setFs]);
  const markWatched = () => {
    if (!info) return;
    api.markWatched([info.episode.id], true).then(() => {
      if (!markedWatched.current) emit("episode:watched", { episode: { ...info.episode, watched: true }, series: info.series });
      markedWatched.current = true;
      showOsd(t("player.markedWatched"));
    }).catch(fail);
  };

  // Tastatur
  useEffect(() => {
    const sc = settings.shortcuts;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (handlePluginShortcut(e, true)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const is = (a: string) => (sc[a]?.length === 1 ? sc[a].toLowerCase() : sc[a]) === k;
      let handled = true;
      if (is("playPause") || k === "k") togglePlay();
      else if (is("seekForward")) seekBy(e.shiftKey ? 30 : 10);
      else if (is("seekBackward")) seekBy(e.shiftKey ? -30 : -10);
      else if (is("volumeUp")) changeVolume(0.05);
      else if (is("volumeDown")) changeVolume(-0.05);
      else if (is("mute")) setMuted((m) => !m);
      else if (is("fullscreen")) setFs(!fullscreen);
      else if (is("nextEpisode")) goNext();
      else if (is("previousEpisode")) goPrev();
      else if (is("subtitles")) {
        if (subTrack) loadSub(null);
        else {
          const first = subtitles.find((s) => s.supported);
          if (first) loadSub(first.id);
        }
      } else if (is("speedUp")) changeSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)] ?? 1);
      else if (is("speedDown")) changeSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)] ?? 1);
      else if (is("close")) {
        if (menu) setMenu(null);
        else if (fullscreen && settings.playerWindowMode !== "fullscreen") setFs(false);
        else close();
      } else if (/^[0-9]$/.test(k) && video.current?.duration) video.current.currentTime = (video.current.duration * Number(k)) / 10;
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        poke();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  });

  // Steuerelemente automatisch ausblenden
  const poke = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  };
  useEffect(() => {
    poke();
    return () => clearTimeout(idleTimer.current);
  }, []);

  // Countdown zur nächsten Folge
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) {
      goNext();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => (c == null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown, goNext]);

  // ---------- Video-Ereignisse ----------
  const onLoadedMetadata = () => {
    const v = video.current!;
    setDuration(v.duration);
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = speed;
    readAudioTracks();
    const pos = info?.episode.position ?? 0;
    const resumable = pos > 10 && !info?.episode.watched && v.duration && pos < v.duration - 15;
    if (resumable) {
      if (settings.autoResume) {
        v.currentTime = pos;
        setResumedAt(pos);
        setTimeout(() => setResumedAt(null), 7000);
      } else {
        setResumeOffer(pos);
      }
    }
    v.play().catch(() => {});
  };
  const onTimeUpdate = () => {
    const v = video.current!;
    if (!seekDrag) setTime(v.currentTime);
    if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
    if (Date.now() - lastSaved.current > 5000 && !v.paused) {
      save();
      if (info) emit("player:progress", { episode: info.episode, series: info.series, time: v.currentTime, duration: isFinite(v.duration) ? v.duration : null });
    }
  };
  const onEnded = () => {
    save(true);
    if (info) emit("player:ended", { episode: info.episode, series: info.series });
    setPlaying(false);
    if (info?.nextId && settings.autoNext && settings.endBehavior !== "stop") {
      if (settings.endBehavior === "next") goNext();
      else setCountdown(settings.nextCountdownSeconds);
    } else setEnded(true);
  };
  const onError = () => {
    const err = video.current?.error;
    const code = err?.code;
    setWaiting(false);
    setMediaError(code === 3 ? t("player.errorDecode") : code === 4 ? t("player.errorFormat") : code === 2 ? t("player.errorNetwork") : t("player.errorGeneric"));
    api.log("warn", `Wiedergabefehler ${code} (${err?.message}) für ${info?.episode.filePath}`);
  };

  // ---------- Fortschrittsleiste ----------
  const seekRef = useRef<HTMLDivElement>(null);
  const posFromEvent = (clientX: number) => {
    const r = seekRef.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { x: f * r.width, t: f * (duration || 0) };
  };
  const startSeek = (e: React.MouseEvent) => {
    setSeekDrag(true);
    const p = posFromEvent(e.clientX);
    setTime(p.t);
    const move = (ev: MouseEvent) => {
      const q = posFromEvent(ev.clientX);
      setTime(q.t);
      setSeekHover(q);
    };
    const up = (ev: MouseEvent) => {
      const q = posFromEvent(ev.clientX);
      if (video.current) video.current.currentTime = q.t;
      setSeekDrag(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const ep = info?.episode;
  const showNextButton = !!info?.next && duration > 0 && duration - time < 90 && duration - time > 1 && countdown == null && !ended;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const allSubs = useMemo(() => [...subtitles, ...extraSubs.map((x) => ({ id: x.id, label: x.label, language: null, source: "external" as const, codec: "", supported: true, default: false }))], [subtitles, extraSubs]);
  const cueStyle = `
    .player .cues .cue-line {
      color: ${settings.subtitleColor};
      font-size: ${(3.1 * settings.subtitleSize) / 100}vh;
      background: ${settings.subtitleBackground ? "rgba(0,0,0,0.72)" : "transparent"};
      text-shadow: ${settings.subtitleBackground ? "none" : "0 0 4px #000, 0 0 3px #000, 0 2px 5px #000"};
    }`;

  // Für Plugins immer die aktuellen Steuerfunktionen bereithalten
  controls.current = {
    play: () => video.current?.paused && togglePlay(),
    pause: () => video.current && !video.current.paused && togglePlay(),
    seek: seekBy,
    next: goNext,
    previous: goPrev,
    close,
    osd: showOsd,
  };

  return (
    <div
      ref={root}
      className={`player ${fullscreen ? "" : "windowed"} ${idle && playing && !menu ? "idle" : ""}`}
      onMouseMove={poke}
      onWheel={(e) => changeVolume(e.deltaY < 0 ? 0.05 : -0.05)}
    >
      <style>{cueStyle}</style>
      {info && !loadError && (
        <video
          ref={video}
          src={videoUrl(info.episode.id)}
          crossOrigin="anonymous"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onDurationChange={() => setDuration(video.current?.duration ?? 0)}
          onPlay={() => { setPlaying(true); setEnded(false); }}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onEnded={onEnded}
          onError={onError}
          onClick={() => (menu ? setMenu(null) : togglePlay())}
          onDoubleClick={() => setFs(!fullscreen)}
        >
          {subUrl && <track key={subUrl} kind="subtitles" src={subUrl} default label="Untertitel" />}
        </video>
      )}

      <div ref={cueBox} className={`cues ${idle && playing && !menu ? "" : "raised"}`} />

      {(waiting || subLoading) && !mediaError && !loadError && (
        <div className="p-loading"><div className="spinner lg" /></div>
      )}
      {flash && (
        <div className="p-center"><div className="p-flash">{flash === "play" ? <Play size={38} fill="#fff" /> : <Pause size={38} fill="#fff" />}</div></div>
      )}
      {osd && <div className="p-osd">{osd}</div>}
      {subLoading && <div className="p-osd" style={{ top: 140 }}>{t("player.loadingSubtitle")}</div>}

      {/* Oben */}
      <div className="player-top">
        <button className="p-btn" onClick={close} title={t("player.back")}><ArrowLeft size={24} /></button>
        <div className="ttl">
          {ep && (
            <>
              <div className="s">{ep.seriesTitle ?? ep.fileName} · {episodeCode(ep)}</div>
              <div className="e">{episodeTitle(ep)}</div>
            </>
          )}
        </div>
        {ep && !ep.watched && !markedWatched.current && (
          <button className="btn glass small" onClick={markWatched}><Check size={15} /> {t("player.markWatched")}</button>
        )}
        {ep && (
          <button className="btn glass small" onClick={() => { video.current?.pause(); api.openDefault(ep.id).catch(fail); }}>
            <ExternalLink size={15} /> {t("player.openExternal")}
          </button>
        )}
      </div>

      {/* Fehler */}
      {(loadError || mediaError) && (
        <div className="p-card p-error">
          <AlertTriangle size={40} color="var(--warning)" />
          <h3>{t("player.errorTitle")}</h3>
          <p style={{ whiteSpace: "pre-line" }}>{loadError ?? mediaError}</p>
          <p className="hint" style={{ color: "rgba(255,255,255,.5)" }}>{t("player.errorHint")}</p>
          {ep && <p style={{ fontSize: 12, color: "rgba(255,255,255,.45)", wordBreak: "break-all" }}>{ep.filePath}</p>}
          <div className="btn-row" style={{ justifyContent: "center", marginTop: 18 }}>
            {!loadError && ep && (
              <>
                <button className="btn primary" onClick={() => api.openDefault(ep.id).catch(fail)}><ExternalLink size={16} /> {t("player.openExternal")}</button>
                <button className="btn glass" onClick={() => api.reveal(ep.id).catch(fail)}><FolderInput size={16} /> {t("ep.reveal")}</button>
              </>
            )}
            <button className="btn glass" onClick={close}>{t("common.close")}</button>
          </div>
        </div>
      )}

      {/* Fortsetzen */}
      {resumeOffer != null && (
        <div className="p-card p-resume">
          <span>{t("player.resumeAsk", { t: formatDuration(resumeOffer) })}</span>
          <button className="btn primary small" onClick={() => { if (video.current) video.current.currentTime = resumeOffer; setResumeOffer(null); }}>{t("player.resume")}</button>
          <button className="btn glass small" onClick={() => setResumeOffer(null)}>{t("player.fromStart")}</button>
        </div>
      )}
      {resumedAt != null && (
        <div className="p-card p-resume">
          <span>{t("player.resumed", { t: formatDuration(resumedAt) })}</span>
          <button className="btn glass small" onClick={() => { if (video.current) video.current.currentTime = 0; setResumedAt(null); }}>
            <RotateCcw size={14} /> {t("player.fromStart")}
          </button>
        </div>
      )}

      {/* Nächste Folge */}
      {showNextButton && settings.endBehavior !== "stop" && (
        <button className="btn white p-skip-next" onClick={goNext}><SkipForward size={16} /> {t("player.next")}</button>
      )}
      {countdown != null && info?.next && (
        <div className="p-card p-next">
          <div style={{ fontWeight: 700 }}>{t("player.nextIn", { s: countdown })}</div>
          <div className="nthumb">
            {imageUrl(info.next.thumbnailPath ?? info.series?.bannerPath) && <img src={imageUrl(info.next.thumbnailPath ?? info.series?.bannerPath)!} alt="" />}
            <div className="ring">{countdown}</div>
          </div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,.7)" }}>{episodeCode(info.next)}</div>
          <div style={{ fontWeight: 600, marginBottom: 14 }}>{episodeTitle(info.next)}</div>
          <div className="btn-row">
            <button className="btn primary" onClick={goNext}><Play size={16} fill="currentColor" /> {t("player.playNow")}</button>
            <button className="btn glass" onClick={() => { setCountdown(null); setEnded(true); }}>{t("player.stay")}</button>
          </div>
        </div>
      )}
      {ended && countdown == null && (
        <div className="p-card p-error">
          <h3>{t("player.ended")}</h3>
          <div className="btn-row" style={{ justifyContent: "center", marginTop: 16 }}>
            <button className="btn glass" onClick={() => { if (video.current) { video.current.currentTime = 0; video.current.play(); } setEnded(false); }}>
              <RotateCcw size={16} /> {t("player.replay")}
            </button>
            {info?.nextId && <button className="btn primary" onClick={goNext}><SkipForward size={16} /> {t("player.next")}</button>}
            <button className="btn glass" onClick={close}>{t("common.close")}</button>
          </div>
        </div>
      )}

      {/* Menüs */}
      {menu === "subs" && (
        <div className="p-menu">
          <h4>{t("player.subtitles")}</h4>
          <button className={!subTrack ? "active" : ""} onClick={() => loadSub(null)}>{!subTrack && <Check size={15} />} {t("player.off")}</button>
          {allSubs.map((s) => (
            <button key={s.id} disabled={!s.supported} className={subTrack === s.id ? "active" : ""} onClick={() => loadSub(s.id)} title={s.supported ? "" : t("player.imageSubsUnsupported")}>
              {subTrack === s.id && <Check size={15} />} {s.label} <span style={{ opacity: 0.5, fontSize: 12 }}>{s.codec}{s.source === "embedded" ? " · MKV" : ""}</span>
            </button>
          ))}
          {allSubs.some((s) => !s.supported) && <div className="note">{t("player.imageSubsUnsupported")}</div>}
          <hr />
          <button onClick={loadExternalSub}><Captions size={15} /> {t("player.loadSubtitle")}</button>
        </div>
      )}
      {menu === "audio" && (
        <div className="p-menu">
          <h4>{t("player.audio")}</h4>
          {audioTracks.length <= 1 && <div className="note">{t("player.noAudioTracks")}</div>}
          {audioTracks.length > 1 &&
            audioTracks.map((a, i) => (
              <button key={a.id} className={a.enabled ? "active" : ""} onClick={() => selectAudio(i)}>
                {a.enabled && <Check size={15} />} {a.label || `${t("player.audio")} ${i + 1}`} {a.language && <span style={{ opacity: 0.5 }}>({a.language})</span>}
              </button>
            ))}
        </div>
      )}
      {menu === "speed" && (
        <div className="p-menu" style={{ minWidth: 180 }}>
          <h4>{t("player.speed")}</h4>
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? "active" : ""} onClick={() => changeSpeed(s)}>
              {speed === s && <Check size={15} />} {s === 1 ? "Normal" : `${s.toLocaleString("de-DE")}×`}
            </button>
          ))}
        </div>
      )}

      {/* Unten */}
      <div className="player-bottom">
        <div
          ref={seekRef}
          className={`seek ${seekDrag ? "dragging" : ""}`}
          onMouseDown={startSeek}
          onMouseMove={(e) => setSeekHover(posFromEvent(e.clientX))}
          onMouseLeave={() => !seekDrag && setSeekHover(null)}
        >
          <div className="rail">
            <div className="buf" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
            <div className="fill" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
          </div>
          <div className="knob" style={{ left: `${duration ? (time / duration) * 100 : 0}%` }} />
          {seekHover && duration > 0 && <div className="tip" style={{ left: seekHover.x }}>{formatDuration(seekHover.t)}</div>}
        </div>
        <div className="p-controls">
          <button className="p-btn" disabled={!info?.previousId} onClick={goPrev} title={t("player.previous")}><SkipBack size={20} /></button>
          <button className="p-btn" onClick={() => seekBy(-10)} title={t("shortcut.seekBackward")}><RotateCcw size={22} /><span className="sub10">10</span></button>
          <button className="p-btn big" onClick={togglePlay} title={playing ? t("player.pause") : t("player.play")}>
            {playing ? <Pause size={28} fill="#fff" /> : <Play size={28} fill="#fff" />}
          </button>
          <button className="p-btn" onClick={() => seekBy(10)} title={t("shortcut.seekForward")}><RotateCw size={22} /><span className="sub10">10</span></button>
          <button className="p-btn" disabled={!info?.nextId} onClick={goNext} title={t("player.next")}><SkipForward size={20} /></button>
          <div className="vol">
            <button className="p-btn" onClick={() => setMuted(!muted)} title={muted ? t("player.unmute") : t("player.mute")}><VolIcon size={21} /></button>
            <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }} />
          </div>
          <span className="p-time">{formatDuration(time)} / {formatDuration(duration)}</span>
          <div className="p-spacer" />
          {info && registry.playerButtons.map((b) => (
            <button
              key={b.uid}
              className="p-btn plugin-p-btn"
              title={b.label}
              onClick={() => {
                try {
                  b.onClick({ episode: info.episode, series: info.series, video: video.current });
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {iconNode(b.icon) ?? <span className="p-btn-label">{b.label}</span>}
            </button>
          ))}
          <button className={`p-btn ${speed !== 1 ? "active" : ""}`} onClick={() => setMenu(menu === "speed" ? null : "speed")} title={t("player.speed")}>
            <Gauge size={20} />
          </button>
          <button className="p-btn" onClick={() => setMenu(menu === "audio" ? null : "audio")} title={t("player.audio")}><Languages size={20} /></button>
          <button className="p-btn" onClick={() => setMenu(menu === "subs" ? null : "subs")} title={t("player.subtitles")}>
            <Captions size={21} color={subTrack ? "var(--accent-2)" : "#fff"} />
          </button>
          <button className="p-btn" onClick={() => setFs(!fullscreen)} title={fullscreen ? t("player.exitFullscreen") : t("player.fullscreen")}>
            {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}
