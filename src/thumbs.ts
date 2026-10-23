// Erzeugt Episoden-Vorschaubilder direkt aus den Videodateien (ohne zusätzliche Programme):
// Video unsichtbar laden, zu einer Stelle springen, Bild auf ein Canvas zeichnen, als JPEG speichern.
import { api, videoUrl } from "./api";

type Job = { id: string; resolve: (rel: string | null) => void };
const queue: Job[] = [];
const failed = new Set<string>();
const pending = new Set<string>();
let running = false;

function capture(id: string): Promise<{ data: string; duration: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "metadata";
    let done = false;
    const finish = (r: { data: string; duration: number } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), 15000);
    v.onloadedmetadata = () => {
      const d = v.duration;
      if (!isFinite(d) || d <= 0) return finish(null);
      // Nach Intro/Logos, aber vor dem Ende
      v.currentTime = Math.min(Math.max(d * 0.18, 5), d * 0.5, 300);
    };
    v.onseeked = () => {
      try {
        const w = 400;
        const h = Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16));
        if (!v.videoWidth) return finish(null);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        finish({ data: c.toDataURL("image/jpeg", 0.78), duration: v.duration });
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    v.src = videoUrl(id);
  });
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    let rel: string | null = null;
    try {
      const r = await capture(job.id);
      if (r) rel = await api.saveThumbnail(job.id, r.data, r.duration);
      else failed.add(job.id);
    } catch {
      failed.add(job.id);
    }
    pending.delete(job.id);
    job.resolve(rel);
  }
  running = false;
}

export function requestThumbnail(id: string): Promise<string | null> {
  if (failed.has(id) || pending.has(id)) return Promise.resolve(null);
  pending.add(id);
  return new Promise((resolve) => {
    queue.push({ id, resolve });
    pump();
  });
}

export function cancelThumbnails() {
  while (queue.length) {
    const j = queue.pop()!;
    pending.delete(j.id);
    j.resolve(null);
  }
}
