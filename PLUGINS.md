# NEXUS ANIME – Plugins

Mit Plugins kannst du NEXUS ANIME um beliebige Funktionen erweitern: eigene Seiten, Menüeinträge, Bereiche auf der Startseite, Player-Knöpfe, Tastenkürzel, Themes, Automatiken bei Ereignissen, Anbindung an Web-Dienste, eigene Skripte und Programme.

> **Achtung:** Plugins haben vollen Zugriff auf die App, deine Bibliothek, das Dateisystem, das Netzwerk und können Programme starten. Installiere nur Plugins, denen du vertraust.

## Schnellstart

1. **Einstellungen → Plugins → Neues Plugin erstellen** – legt einen Ordner mit Vorlage an und öffnet ihn.
2. `main.js` in einem Editor bearbeiten und speichern.
3. **Einstellungen → Plugins → Neu laden** – Änderungen sind sofort aktiv.

Fehler werden direkt an der Plugin-Karte angezeigt und unter *Einstellungen → Daten & Datenschutz → Protokolle* mitgeschrieben. Konsolenausgaben (`console.log`) erscheinen in den Entwicklertools des Fensters.

## Aufbau

Plugins liegen in `%APPDATA%\de.nexus.anime\plugins\<id>\`:

```
plugins/
  mein-plugin/
    manifest.json
    main.js
    style.css        (optional)
```

### manifest.json

```json
{
  "id": "mein-plugin",
  "name": "Mein Plugin",
  "version": "1.0.0",
  "description": "Was das Plugin macht",
  "author": "Dein Name",
  "main": "main.js",
  "styles": ["style.css"],
  "defaultEnabled": true,
  "settings": [
    { "key": "apiKey", "label": "API-Schlüssel", "type": "string" },
    { "key": "aktiv", "label": "Automatisch ausführen", "type": "boolean", "default": true },
    { "key": "modus", "label": "Modus", "type": "select", "options": [["a", "Variante A"], ["b", "Variante B"]], "default": "a" }
  ]
}
```

- Die **ID ist der Ordnername** (erlaubt: a–z, 0–9, `-`, `_`, `.`).
- `styles`: CSS-Dateien, die beim Aktivieren geladen werden (ideal für Themes).
- `settings`: Felder, für die NEXUS automatisch ein Formular an der Plugin-Karte erzeugt. Typen: `boolean`, `string`, `number`, `select`, `text` (mehrzeilig). Werte liest du mit `nexus.config.get("key")`. Nach einer Änderung wird das Plugin neu geladen.

### main.js

Als ES-Modul:

```js
export default function activate(nexus) {
  nexus.ui.toast("success", "Plugin geladen");
  return () => { /* optional: aufräumen beim Deaktivieren */ };
}
```

Oder als einfaches Skript ohne `export` – dann steht `nexus` direkt als Variable bereit.

`activate` darf `async` sein. Statt einer Aufräumfunktion kann es auch `{ deactivate, exports }` zurückgeben; `exports` können andere Plugins über `nexus.plugins.get("id")` nutzen.

Alles, was über `nexus` registriert wird (Seiten, Menüs, Ereignisse, Stile …), wird beim Deaktivieren oder Neuladen automatisch entfernt.

Hinweis: `main.js` wird als einzelne Datei geladen. Relative `import`s funktionieren nicht – mehrere Dateien vorher bündeln (z. B. mit esbuild) oder weitere Dateien mit `nexus.plugin.readFile()` lesen. Externe Module per `import("https://…")` sind möglich.

## Oberfläche bauen

Plugins können Oberflächen auf zwei Arten liefern:

- **`render`** – gibt React-Elemente zurück. Ohne Build-Schritt mit `nexus.h` (= `React.createElement`); Hooks über `nexus.React.useState` usw.
- **`mount(el)`** – erhält ein leeres DOM-Element, das du frei befüllst (HTML, Canvas, andere Bibliotheken). Optional eine Aufräumfunktion zurückgeben.

```js
const { h, React } = nexus;

function Zaehler() {
  const [n, setN] = React.useState(0);
  return h("button", { className: "btn primary", onClick: () => setN(n + 1) }, `Geklickt: ${n}`);
}

nexus.ui.addPage({ id: "zaehler", title: "Zähler", icon: "🔢", nav: "top", render: () => h("div", { className: "page" }, h(Zaehler)) });

nexus.ui.addPage({
  id: "html",
  title: "HTML-Seite",
  mount(el) {
    el.innerHTML = `<div class="page"><h1 class="page-title">Hallo</h1></div>`;
  },
});
```

Nützliche CSS-Klassen der App: `page`, `page-title`, `btn` (+ `primary`, `ghost`, `danger`, `small`, `large`), `input`, `select`, `hint`, `settings-section`, `banner-note`, `stat-tiles`/`stat-tile`. Farben als CSS-Variablen: `--accent`, `--accent-2`, `--text`, `--text-2`, `--surface`, `--surface-2`, `--danger`, `--success`, `--warning`.

Symbole (`icon`) sind Emoji/Text oder ein SVG-String (`"<svg …>…</svg>"`).

## API-Referenz

### nexus.ui – Oberfläche

| Funktion | Beschreibung |
|---|---|
| `addPage({ id, title, icon?, nav?, render \| mount })` | Eigene Seite. `nav`: `"top"` (Hauptnavigation), `"more"` (Menü „Mehr“, Standard), `"none"`. `render(ctx)` erhält `ctx.params`. |
| `openPage(id, params?)` | Eigene Seite öffnen |
| `addEpisodeMenuItem({ label, icon?, danger?, when?, onClick(episode) })` | Eintrag im Episodenmenü (Rechtsklick/⋯) |
| `addSeriesMenuItem({ label, icon?, danger?, when?, onClick(series) })` | Eintrag im ⋯-Menü der Serienseite |
| `addHomeSection({ id, title?, position?, render \| mount })` | Bereich auf der Startseite. `position`: `"top"` oder `"bottom"` (Standard) |
| `addPlayerButton({ label, icon?, onClick(ctx) })` | Knopf in der Player-Leiste. `ctx`: `{ episode, series, video }` |
| `addSettings({ render \| mount })` | Eigener Einstellungsbereich an der Plugin-Karte |
| `addShortcut({ key, ctrl?, shift?, alt?, inPlayer?, run })` | Tastenkürzel (außerhalb oder – mit `inPlayer: true` – im Player) |
| `addStyle(css)` | CSS einfügen; gibt eine Funktion zum Entfernen zurück |
| `toast(kind, title, message?)` | Hinweis; `kind`: `"success"`, `"error"`, `"info"` |
| `dialog({ title, subtitle?, size?, buttons?, render \| mount })` | Dialog. `buttons: [{ label, primary?, danger?, onClick }]` – gibt `onClick` `false` zurück, bleibt er offen |
| `confirm(title, text, { confirmLabel?, danger? }?)` | → `Promise<boolean>` |
| `prompt(title, { label?, initial? }?)` | → `Promise<string \| null>` |
| `menu(mouseEvent, items)` | Kontextmenü an der Mausposition |
| `navigate(name, params?)` | Zu einer Seite: `home`, `library`, `favorites`, `continue`, `unwatched`, `search`, `discover`, `settings`, `series` (`{ id }`), `unsorted`, `duplicates` … |
| `openSeries(id)`, `play(episodeId)`, `back()`, `currentRoute()` | Navigation und Wiedergabe |

### nexus.events – Ereignisse

```js
const off = nexus.events.on("episode:watched", ({ episode, series }) => { … });
```

| Ereignis | Daten |
|---|---|
| `app:ready` | – |
| `route:change` | `{ route }` |
| `library:changed` | – (nach Scans, Zuordnungen, Dateioperationen) |
| `settings:changed` | `{ settings }` |
| `scan:progress` / `scan:finished` | Scan-Fortschritt |
| `metadata:updated` | – |
| `fileops:finished` | Ergebnis der Dateioperation |
| `player:open` | `{ episode, series }` |
| `player:progress` | `{ episode, series, time, duration }` (etwa alle 5 Sekunden) |
| `player:ended` | `{ episode, series }` |
| `player:close` | `{ episode, series, time, duration }` |
| `episode:watched` | `{ episode, series }` – Folge wurde als angesehen markiert |
| `plugins:changed` | Liste der Plugins |

Eigene Ereignisse: `nexus.events.emit("mein:ereignis", daten)`.

### nexus.library – Bibliothek

`series()` (aktuelle Liste), `seriesById(id)`, `detail(id)` (Serie + Episoden), `episodes(filter, limit?)` (Filter: `unwatched`, `continue`, `recent`, `unsorted`, `hidden`, `unavailable`), `search(text)`, `refresh()`.

### nexus.player – laufender Player

`current()` → `{ episode, series, video }` oder `null`; `play()`, `pause()`, `seek(sekunden)`, `next()`, `previous()`, `close()`, `osd(text)`.

### nexus.storage / nexus.config

- `storage.get(key, fallback?)`, `storage.set(key, wert)`, `storage.remove(key)`, `storage.all()` – dauerhaft, JSON-Werte, je Plugin getrennt.
- `config.get(key)`, `config.set(key, wert)`, `config.onChange(fn)` – Werte der Manifest-Einstellungen.

### Systemzugriff

| Funktion | Beschreibung |
|---|---|
| `nexus.http.fetch(url, { method?, headers?, body?, timeoutMs? })` | HTTP ohne CORS. Antwort: `{ status, ok, headers, body, text(), json() }`. Objekte als `body` werden als JSON gesendet. |
| `nexus.fs.read(path)` / `write(path, text)` / `append(path, text)` / `list(dir)` / `exists(path)` | Dateisystem (Text) |
| `nexus.shell.run(programm, args, { cwd?, wait? })` | Programm starten (ohne Shell). Mit Warten: `{ code, stdout, stderr }` |
| `nexus.shell.openFolder(path)` / `openUrl(url)` | Im Explorer / Browser öffnen |
| `nexus.db.query(sql, params?)` | SQL auf der Bibliotheksdatenbank (Tabellen u. a. `series`, `episodes`, `sources`). SELECT → Zeilen, sonst `{ changes }`. Vorsicht beim Schreiben – vorher Backup! |
| `nexus.api.*` | Alle Funktionen der App (z. B. `markWatched`, `assignEpisodes`, `startScan`, `metadataSearch`, `createBackup` …) |
| `nexus.invoke(befehl, args)` | Beliebiger Backend-Befehl direkt |

### Sonstiges

- `nexus.plugin` – `{ id, name, version, dir, manifest, readFile(pfad) }`
- `nexus.app` – `{ version, dataDir, language() }`
- `nexus.settings.get()` / `update(patch)` – Einstellungen der App lesen/ändern
- `nexus.plugins.get(id)` / `list()` – andere Plugins
- `nexus.log(level, …)` – ins App-Protokoll schreiben
- `nexus.utils` – `episodeCode`, `episodeTitle`, `formatBytes`, `formatDate`, `formatDuration`, `relativeTime`, `imageUrl`, `videoUrl`, `t`

## Beispiele

### Folge angesehen → Datei-Protokoll

```js
export default function activate(nexus) {
  const log = nexus.app.dataDir + "\\angesehen.txt";
  nexus.events.on("episode:watched", ({ episode, series }) =>
    nexus.fs.append(log, `${new Date().toLocaleString("de-DE")}  ${series?.title ?? "?"}  ${nexus.utils.episodeCode(episode)}\n`));
}
```

### Player-Knopf: Intro überspringen (+85 s)

```js
export default function activate(nexus) {
  nexus.ui.addPlayerButton({ label: "Intro überspringen", icon: "⏭", onClick: ({ video }) => (video.currentTime += 85) });
  nexus.ui.addShortcut({ key: "i", inPlayer: true, run: () => nexus.player.seek(85) });
}
```

### Theme

`manifest.json` mit `"styles": ["theme.css"]` und in `theme.css`:

```css
:root { --accent: #e11d48; --accent-2: #fb7185; }
.topnav { background: linear-gradient(90deg, #1a0010, #0b0b10); }
```

### Web-Dienst abfragen

```js
export default async function activate(nexus) {
  const r = await nexus.http.fetch("https://api.jikan.moe/v4/random/anime");
  const anime = r.json().data;
  nexus.ui.addHomeSection({
    id: "tipp",
    render: () => nexus.h("div", { className: "banner-note" }, "Zufallstipp: ", nexus.h("b", null, anime.title)),
  });
}
```

### Externes Programm (z. B. mpv) als Episoden-Aktion

```js
export default function activate(nexus) {
  nexus.ui.addEpisodeMenuItem({
    label: "In mpv öffnen",
    icon: "▶",
    onClick: (e) => nexus.shell.run("mpv", [e.filePath], { wait: false }),
  });
}
```

## Installieren & Teilen

- **Ordner installieren**: ein Plugin-Ordner mit `manifest.json` wird in den Plugin-Ordner kopiert.
- **Datei installieren**: eine einzelne `.js`-Datei wird zu einem Plugin (Manifest wird automatisch erzeugt).
- Oder den Ordner selbst nach `%APPDATA%\de.nexus.anime\plugins\` kopieren und **Neu laden** klicken.
- **Entfernen** verschiebt den Plugin-Ordner in den Papierkorb und löscht die gespeicherten Plugin-Daten.
