// Läuft in der Webansicht von NEXUS ANIME in jeder Seite und jedem Frame (siehe webplayer.rs).
// Beobachtet, welche Video-Links der Player der Seite lädt (fetch, XHR, <video>-Quellen,
// Ressourcen-Zeitmessung) und meldet sie über eine Navigation zu nexus-bridge.invalid, die die App
// abfängt und abbricht. Frames geben ihre Funde per postMessage an das oberste Fenster weiter.
(() => {
  if (window.__nexusBridge) return;
  window.__nexusBridge = true;

  const MEDIA = /\.(m3u8|mp4|m4v|webm|mkv|mov)(?:$|[?#])|[?&](?:format|container)=m3u8/i;
  const SKIP = /(?:^|[/_.-])(?:ads?|preroll|vast|banner)(?:[/_.-]|$)/i;
  const seen = new Set();
  const isTop = window.top === window;
  const queue = [];
  let sending = false;

  // Mehrere Navigationen direkt hintereinander würden sich gegenseitig abbrechen – daher nacheinander
  const flush = () => {
    if (sending || !queue.length) return;
    sending = true;
    const m = queue.shift();
    location.href = "https://nexus-bridge.invalid/found?" + new URLSearchParams({ u: m.url, p: m.page });
    setTimeout(() => {
      sending = false;
      flush();
    }, 250);
  };
  const send = (m) => {
    queue.push(m);
    flush();
  };

  const report = (raw) => {
    let url;
    try {
      url = new URL(String(raw), location.href).href;
    } catch {
      return;
    }
    if (!/^https?:/.test(url) || !MEDIA.test(url) || SKIP.test(new URL(url).pathname) || seen.has(url)) return;
    // Varianten und (fMP4-)Segmente nicht einzeln melden, wenn vom selben Server schon ein Manifest kam
    if ([...seen].some((s) => /\.m3u8/i.test(s) && new URL(s).origin === new URL(url).origin)) return;
    seen.add(url);
    const m = { url, page: location.href };
    if (isTop) send(m);
    else {
      try {
        window.top.postMessage({ __nexusStream: m }, "*");
      } catch {
        /* Frame ohne Zugriff */
      }
    }
  };

  if (isTop) {
    window.addEventListener("message", (e) => {
      const m = e.data && e.data.__nexusStream;
      if (m && typeof m.url === "string" && typeof m.page === "string") send(m);
    });
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        report(typeof input === "string" || input instanceof URL ? input : input.url);
      } catch {
        /* ignorieren */
      }
      return origFetch.call(this, input, init);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    report(url);
    return origOpen.apply(this, arguments);
  };

  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      ...srcDesc,
      set(v) {
        report(v);
        srcDesc.set.call(this, v);
      },
    });
  }

  // Alles, was der Browser selbst lädt (auch <video src> und <source> im HTML)
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => report(e.name))).observe({ type: "resource", buffered: true });
  } catch {
    /* ältere WebViews */
  }
})();
