import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Heart, Info, Play, X, XCircle } from "lucide-react";
import { api, imageUrl, Series } from "../api";
import { MenuItem, useStore } from "../store";
import { t } from "../i18n";

export const PROVIDER_NAMES: Record<string, string> = {
  crunchyroll: "Crunchyroll", netflix: "Netflix", prime: "Prime Video", adn: "ADN", disney: "Disney+", hidive: "HIDIVE",
  youtube: "YouTube", joyn: "Joyn", rtlplus: "RTL+", wow: "WOW", apple: "Apple TV", animeondemand: "Anime on Demand",
};

// ---------- Cover mit stilvollem Platzhalter ----------
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export function fallbackGradient(title: string) {
  const h = hash(title);
  const a = h % 360;
  const b = (a + 40 + (h % 60)) % 360;
  return `linear-gradient(150deg, hsl(${a} 55% 38%), hsl(${b} 60% 18%) 70%, hsl(${b} 50% 10%))`;
}
export function initials(title: string) {
  const words = title.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function Cover({ path, title, version, className }: { path: string | null; title: string; version?: string; className?: string }) {
  const src = imageUrl(path, version);
  // Zustand pro Bildquelle merken – ein Reset per Effect würde bereits gecachte Bilder wieder verstecken
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const loaded = loadedSrc === src;
  const failed = failedSrc === src;
  return (
    <div className={`cover ${className ?? ""}`}>
      {src && !failed ? (
        <img src={src} alt="" className={loaded ? "" : "loading"} onLoad={() => setLoadedSrc(src)} onError={() => setFailedSrc(src)} loading="lazy" draggable={false} />
      ) : (
        <div className="cover-fallback" style={{ background: fallbackGradient(title) }}>
          <div className="initials">{initials(title)}</div>
          <div className="ft">{title}</div>
        </div>
      )}
    </div>
  );
}

export const ProgressBar = ({ value, large }: { value: number; large?: boolean }) => (
  <div className={`progress ${large ? "lg" : ""}`}>
    <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
  </div>
);

export const Switch = ({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <label className="switch" style={disabled ? { opacity: 0.5 } : undefined}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span />
  </label>
);

export function Empty({ icon, title, text, children }: { icon: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

export const Loading = () => (
  <div className="loading-page">
    <div className="spinner lg" />
  </div>
);

// ---------- Modal ----------
export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  size,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: "wide" | "xwide";
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ""}`} role="dialog">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  text,
  confirmLabel,
  danger,
  onConfirm,
}: {
  title: string;
  text: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const { closeDialog, fail } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common.cancel")}
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                closeDialog();
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel ?? t("common.confirm")}
          </button>
        </>
      }
    >
      <div style={{ color: "var(--text-2)", lineHeight: 1.6 }}>{text}</div>
    </Modal>
  );
}

// ---------- Kontextmenü ----------
export function ContextMenu() {
  const { menu, closeMenu } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 10), y: Math.min(menu.y, window.innerHeight - r.height - 10) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    setTimeout(() => {
      window.addEventListener("mousedown", h);
      window.addEventListener("contextmenu", h);
    });
    window.addEventListener("keydown", k);
    window.addEventListener("blur", closeMenu);
    document.querySelector(".main")?.addEventListener("scroll", closeMenu, { once: true });
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("contextmenu", h);
      window.removeEventListener("keydown", k);
      window.removeEventListener("blur", closeMenu);
    };
  }, [menu, closeMenu]);
  if (!menu) return null;
  return (
    <div className="ctx" ref={ref} style={{ left: pos.x || menu.x, top: pos.y || menu.y }}>
      {menu.items.map((it, i) =>
        "divider" in it ? (
          <hr key={i} />
        ) : "title" in it ? (
          <div key={i} className="ctx-title">
            {it.title}
          </div>
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onClick={() => {
              closeMenu();
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export const menuButton = (items: () => MenuItem[], open: (e: { clientX: number; clientY: number }, items: MenuItem[]) => void) => (e: React.MouseEvent) => {
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  open({ clientX: r.left, clientY: r.bottom + 6 }, items());
};

// ---------- Toasts ----------
export function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toasts">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} onClick={() => dismissToast(x.id)}>
          <div className="ic">{x.kind === "success" ? <CheckCircle2 size={19} /> : x.kind === "error" ? <XCircle size={19} /> : <Info size={19} />}</div>
          <div>
            <div className="tt">{x.title}</div>
            {x.message && <div className="tm">{x.message}</div>}
            {x.action && (
              <div className="ta">
                <button
                  className="btn small"
                  onClick={(e) => {
                    e.stopPropagation();
                    x.action!.run();
                    dismissToast(x.id);
                  }}
                >
                  {x.action.label}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Horizontale Reihe ----------
export function Shelf({ title, count, onMore, children }: { title: string; count?: number; onMore?: () => void; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = () => {
    const el = track.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (track.current) ro.observe(track.current);
    return () => ro.disconnect();
  }, [children]);
  const scroll = (dir: number) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.85, behavior: "smooth" });
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2 className="shelf-title">
          {title}
          {count != null && <span className="count">{count}</span>}
        </h2>
        {onMore && (
          <button className="shelf-link" onClick={onMore}>
            {t("home.showAll")} <ChevronRight size={15} />
          </button>
        )}
      </div>
      <div className="shelf-wrap">
        <button className="shelf-arrow left" disabled={!edges.left} onClick={() => scroll(-1)}>
          <ChevronLeft size={34} />
        </button>
        <div className="shelf-track" ref={track} onScroll={update}>
          {children}
        </div>
        <button className="shelf-arrow right" disabled={!edges.right} onClick={() => scroll(1)}>
          <ChevronRight size={34} />
        </button>
      </div>
    </section>
  );
}

// ---------- Serienkarte ----------
export function SeriesCard({
  s,
  dragProps,
  className,
}: {
  s: Series;
  dragProps?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  className?: string;
}) {
  const { navigate, fail, reloadSeries, toast } = useStore();
  const unwatched = s.availableCount - Math.min(s.watchedCount, s.availableCount);
  const progress = s.episodeCount ? s.watchedCount / s.episodeCount : 0;
  const started = s.watchedCount > 0 || s.inProgressCount > 0;
  const toggleFav = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.setFavorite(s.id, !s.favorite);
      toast("success", s.favorite ? t("toast.favoriteOff") : t("toast.favoriteOn"), s.title);
      reloadSeries();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <div
      className={`card ${className ?? ""}`}
      tabIndex={0}
      onClick={() => navigate({ name: "series", params: { id: s.id } })}
      onKeyDown={(e) => e.key === "Enter" && navigate({ name: "series", params: { id: s.id } })}
      {...dragProps}
    >
      <div style={{ position: "relative" }}>
        <Cover path={s.coverPath} title={s.title} version={s.updatedAt} />
        <div className="card-overlay">
          <div className="play-bubble">
            <Play size={22} fill="currentColor" />
          </div>
        </div>
        <div className="badges">
          <span>
            {unwatched > 0 && started && <span className="badge new">{t("library.unwatchedBadge", { n: unwatched })}</span>}
            {s.unavailableCount > 0 && s.unavailableCount === s.episodeCount && <span className="badge warn">{t("ep.unavailable")}</span>}
          </span>
        </div>
        <button className={`fav-btn ${s.favorite ? "on" : ""}`} onClick={toggleFav} title={s.favorite ? t("series.unfavorite") : t("series.addFavorite")}>
          <Heart size={15} fill={s.favorite ? "currentColor" : "none"} />
        </button>
        {started && progress < 1 && (
          <div className="cover-progress">
            <ProgressBar value={progress} />
          </div>
        )}
      </div>
      <div className="card-info">
        <div className="card-title">{s.title}</div>
        <div className="card-meta">
          <span>
            {s.episodeCount === 0 && s.onlineProvider
              ? t("link.online", { p: PROVIDER_NAMES[s.onlineProvider] ?? "Link" })
              : s.episodeCount === 1
                ? t("card.episode1")
                : t("card.episodes", { n: s.episodeCount })}
          </span>
          {s.year && (
            <>
              <span className="sep">·</span>
              <span>{s.year}</span>
            </>
          )}
          {s.genres[0] && (
            <>
              <span className="sep">·</span>
              <span>{s.genres[0]}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


const PROVIDER_DOMAINS: [string, string[]][] = [
  ["crunchyroll", ["crunchyroll.com"]], ["netflix", ["netflix.com"]], ["prime", ["primevideo.com", "amazon.de", "amazon.com", "amazon.co.uk", "amazon.at"]],
  ["adn", ["animationdigitalnetwork.com", "animationdigitalnetwork.de", "animationdigitalnetwork.fr"]], ["disney", ["disneyplus.com"]], ["hidive", ["hidive.com"]],
  ["youtube", ["youtube.com", "youtu.be"]], ["joyn", ["joyn.de", "joyn.at"]], ["rtlplus", ["plus.rtl.de"]], ["wow", ["wowtv.de"]], ["apple", ["tv.apple.com"]],
];

/** Anbieter eines Links (gleiche Logik wie im Backend): bekannter Name oder die Webadresse. */
export function providerOf(url: string): { key: string; name: string } {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { key: "web", name: url };
  }
  const hit = PROVIDER_DOMAINS.find(([, ds]) => ds.some((d) => host === d || host.endsWith(`.${d}`)));
  return hit ? { key: hit[0], name: PROVIDER_NAMES[hit[0]] } : { key: "web", name: host.replace(/^www\./, "") };
}
