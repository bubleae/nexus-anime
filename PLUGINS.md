# NEXUS ANIME – Plugins

Mit Plugins in **JavaScript oder Python** kannst du NEXUS ANIME um beliebige Funktionen erweitern: eigene Seiten, Menüeinträge, Bereiche auf der Startseite, Player-Knöpfe, Tastenkürzel, Themes, Automatiken bei Ereignissen, Anbindung an Web-Dienste, eigene Skripte und Programme.

> **Achtung:** Plugins haben vollen Zugriff auf die App, deine Bibliothek, das Dateisystem, das Netzwerk und können Programme starten. Installiere nur Plugins, denen du vertraust.

## Schnellstart

1. **Einstellungen → Plugins → Neues JS-Plugin** oder **Neues Python-Plugin** – legt einen Ordner mit Vorlage an und öffnet ihn.
2. `main.js` bzw. `main.py` in einem Editor bearbeiten und speichern.
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
- **`html` + `actions`** – HTML-String (oder Funktion, die einen liefert) mit `data-action`-Knöpfen; siehe *Python-Plugins*. Geht auch in JavaScript.

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

## Python-Plugins

Python-Plugins sind normale Python-Skripte (`main.py`). Sie laufen als eigener Prozess mit dem auf dem PC installierten **Python 3** (von python.org, mit „Add python.exe to PATH“). Gefunden wird `python`, sonst `py -3`; ein bestimmtes Python stellst du im Manifest ein: `"python": "C:\\Pfad\\zu\\python.exe"`. Pakete aus `pip install …` können ganz normal importiert werden, ebenso weitere `.py`-Dateien aus dem Plugin-Ordner.

```json
{ "id": "mein-python-plugin", "name": "Mein Python-Plugin", "version": "1.0.0", "main": "main.py" }
```

```python
import nexus

def seite(ctx):
    serien = nexus.library.series()
    zeilen = "".join(f"<li>{s.title} – {s.watched_count}/{s.episode_count}</li>" for s in serien)
    return f'<div class="page"><h1 class="page-title">Meine Serien</h1><ul>{zeilen}</ul>' \
           f'<button class="btn primary" data-action="hallo">Hallo</button></div>'

def hallo(data):
    nexus.ui.toast("success", "Hallo aus Python!")

nexus.ui.add_page(id="liste", title="Serienliste", icon="🐍", nav="top", html=seite, actions={"hallo": hallo})

@nexus.on("episode:watched")
def angesehen(data):
    print("Angesehen:", data.series.title if data.series else "?", data.episode.file_name)
```

**So funktioniert es:**

- Es ist dieselbe API wie bei JavaScript, nur in Python-Schreibweise: `nexus.ui.add_page(...)` ruft `nexus.ui.addPage(...)` auf, `nexus.library.series()` liefert die Serienliste usw. Jeder Aufruf wartet auf die Antwort der App.
- **Schlüsselwort-Argumente** werden zu einem Objekt: `add_page(id="x", title="Y", html=fn)` entspricht `addPage({ id: "x", title: "Y", html: fn })`. Positionsargumente bleiben, wie sie sind: `nexus.ui.toast("success", "Titel", "Text")`.
- **Funktionen** (z. B. `on_click=…`, `html=…`, Ereignis-Handler) übergibst du einfach; die App ruft sie später auf. Sie laufen in eigenen Threads und dürfen selbst wieder `nexus`-Funktionen aufrufen. Parameter, die du nicht brauchst, kannst du weglassen (`def klick(): …`).
- **Ergebnisse** sind Dicts mit Attributzugriff: `episode.file_name`, `episode.fileName` und `episode["fileName"]` gehen alle.
- **Oberflächen** aus Python sind HTML: `html` ist ein String oder eine Funktion, die HTML zurückgibt. Elemente mit `data-action="name"` rufen `actions["name"](daten)` auf, danach wird die Ansicht neu gezeichnet. `daten` enthält die `data-…`-Attribute des Elements und alle Formularfelder mit `name`. Ein `<form data-action="…">` wird beim Absenden ausgelöst. Links auf `http(s)://` öffnen sich im Browser. Das funktioniert für Seiten, Startseiten-Bereiche (`add_home_section`), Einstellungsbereiche (`add_settings`) und Dialoge (`nexus.ui.dialog(title=…, html=…, actions=…)`).
- `print()` landet im Protokoll der App, Fehler mit vollständigem Traceback ebenso. Stürzt das Skript beim Start ab, steht der Fehler an der Plugin-Karte.
- Nach dem Start bleibt der Prozess aktiv, bis das Plugin deaktiviert, neu geladen oder die App geschlossen wird. Schleifen oder Zeitgeber legst du am besten in einen eigenen Thread (`threading.Thread(target=…, daemon=True).start()`).
- Weitere Hilfen: `nexus.call("ui.toast", "info", "Text")` (beliebiger Pfad der API), `nexus.invoke(befehl, args)`, `nexus.log(level, text)`, `nexus.plugin_id`, `nexus.plugin_dir`, `nexus.data_dir`; Eigenschaften lesen mit Klammern, z. B. `nexus.app.version()`.

Einschränkungen: `render`/`mount` (React/DOM) gibt es nur in JavaScript – in Python nimmst du `html`. Menü-Optionen wie `when` oder eine Beschriftung als Funktion (`label=lambda …`) werden nicht unterstützt; `label` ist in Python immer ein Text.

## Suchquellen für „Entdecken“

Ein Plugin kann eine eigene **Suchquelle** anmelden. Die Seite *Entdecken* durchsucht dann AniList und alle aktiven Quellen gleichzeitig und zeigt jede Quelle als eigenen Abschnitt mit Kacheln (oben lässt sich nach Quelle filtern). Ein Klick öffnet eine Detailseite mit Banner, Cover, Beschreibung und Episodenliste; ein Klick auf eine Folge spielt sie im integrierten Player.

```python
import nexus

def suchen(query):
    # Liste von Treffern – mindestens id und title
    return [{"id": "42", "title": "Mein Film", "year": 2024, "cover_url": "https://…/cover.jpg"}]

def details(item):
    # item ist der Treffer von oben (mit Attributzugriff: item.id, item.title …)
    return {
        "description": "…",
        "banner_url": "https://…/banner.jpg",
        "episodes": [
            {"number": 1, "title": "Folge 1", "stream_url": "http://192.168.1.10:8096/…/master.m3u8?api_key=…"},
        ],
    }

nexus.discover.add_source(id="meine-quelle", name="Mein Server", icon="📺", search=suchen, details=details)
```

In JavaScript genauso: `nexus.discover.addSource({ id, name, icon, search: async (q) => [...], details: async (item) => ({...}) })`.

**Felder eines Treffers** (snake_case oder camelCase, alles außer `id`/`title` optional): `id`, `title`, `subtitle`, `description`, `cover_url`, `banner_url`, `year`, `genres`, `url` (Seite im Browser), `episodes` (dann ist `details` nicht nötig). Alle weiteren Felder bleiben erhalten und kommen in `details(item)` wieder an.

**Felder einer Episode:** `number`, `season`, `title`, `description`, `thumbnail`, `duration` (Sekunden), `stream_url` (spielt im Player – MP4/WebM/MKV oder HLS), `url` (öffnet sich im Browser, falls kein `stream_url`), `subtitles` (`[{ "url", "label", "lang" }]`, SRT/VTT).

`details` ergänzt den Treffer: Felder, die es nicht liefert, bleiben aus dem Suchergebnis. Antwortet eine Quelle nicht innerhalb von 30 Sekunden oder wirft sie einen Fehler, erscheint der Fehler nur in ihrem Abschnitt.

Nur Quellen verwenden, die du nutzen darfst (eigener Medienserver, freie Inhalte, Dienste mit offizieller Schnittstelle). Ein fertiges Beispiel für **Jellyfin** liegt im Repository unter [`examples/plugins/jellyfin-quelle`](examples/plugins/jellyfin-quelle) – Ordner über *Einstellungen → Plugins → Ordner installieren* hinzufügen, dann Server und API-Schlüssel eintragen.

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

`current()` → `{ episode, series, video, stream }` oder `null`; `play()`, `pause()`, `seek(sekunden)`, `next()`, `previous()`, `close()`, `osd(text)`.

**Eigene Stream-Links abspielen:** `playUrl(url, optionen?)` (Python: `nexus.player.play_url(url, …)`) spielt einen http(s)-Link direkt im integrierten Player – z. B. vom eigenen Jellyfin-, Plex- oder Emby-Server oder einem NAS im Heimnetz.

| Option | Bedeutung |
|---|---|
| `title` | Titel im Player |
| `subtitle` | zweite Zeile, z. B. Serienname |
| `subtitles` | Liste `[{ url, label?, lang? }]` – SRT oder VTT per Link |
| `startAt` | Startposition in Sekunden (sonst die gemerkte Position) |
| `key` | eigener Schlüssel für gemerkte Position und Ereignisse (Standard: die URL) |
| `type` | `"hls"` oder `"file"` erzwingen (sonst anhand der URL erkannt) |
| `page` | Webseite, auf der der Link gefunden wurde (für „Webansicht“ und „Im Browser öffnen“) |
| `headers` | Header, die der Server verlangt (z. B. `Referer`) – nur für externe Player, der integrierte Player kann sie nicht senden |

Unterstützt werden direkte Videodateien (MP4, WebM, MKV mit H.264/AAC u. ä.) und HLS (`.m3u8`). Zugangsschlüssel gehören in den Link (Jellyfin `api_key=…`, Plex `X-Plex-Token=…`). Für HLS muss der Server Zugriffe aus der App erlauben (CORS) – Jellyfin und Plex tun das. Bei Streams enthalten die `player:*`-Ereignisse zusätzlich `stream` (mit `url`, `title`, `key` …); `episode:watched` wird für Streams nicht ausgelöst. Die Position wird nur lokal gemerkt.

Nur Inhalte abspielen, die du nutzen darfst. Seiten von Streaming-Anbietern sind keine direkten Video-Links; kopiergeschützte Streams lassen sich nicht abspielen.

**Webseiten statt Video-Links (Resolver):** Ohne erkennbare Endung (`.mp4`, `.m3u8` …) und ohne `type` lädt der Player zuerst nur den Anfang des Links und erkennt, ob dahinter ein Video, ein HLS-Manifest oder eine HTML-Seite liegt. Bei einer Seite fragt er der Reihe nach die registrierten Resolver:

`addResolver({ id, name, resolve })` (Python: `nexus.player.add_resolver(id=…, name=…, resolve=fn)`) – `resolve(url)` gibt eine Stream-Beschreibung wie bei `playUrl` zurück (`{ url, type?, title?, subtitles?, page?, headers? }`) oder `null`, wenn es nichts gefunden hat. Eine Ausnahme erscheint als Meldung im Player (z. B. „kopiergeschützt“). Höchstens 60 Sekunden je Resolver.

Findet kein Resolver etwas, bietet der Player die **Webansicht** an: Die Seite öffnet sich in einem eigenen Fenster (ohne Zugriff auf die App, Pop-ups gesperrt). Ein Skript in jeder Seite und jedem Frame beobachtet, welche Video-Links der Player der Seite lädt; sie erscheinen im NEXUS-Player zum Abspielen. Dasselbe passiert, wenn ein Link mit dem Fehler „Format nicht unterstützt“ (`MEDIA_ERR_SRC_NOT_SUPPORTED`) scheitert und sich als Webseite herausstellt.

Ein fertiger Resolver in Python liegt unter [`examples/plugins/stream-extractor`](examples/plugins/stream-extractor): Er wertet `<video>`/`<source>`, `og:video`, JSON-LD und Player-Konfigurationen im Skript-Code aus, folgt eingebetteten `<iframe>`-Playern, sendet den passenden `Referer` und lehnt DRM-geschützte Streams ab. Dazu gibt es einen Player-Knopf, der den Stream in **mpv** oder **VLC** öffnet – nützlich, wenn der Server einen Referer verlangt oder CORS sperrt. Tests: `python -m unittest test_extractor` im Plugin-Ordner.

```python
import nexus

# Jellyfin: direkte Datei (ohne Umwandlung) eines Elements abspielen
SERVER = "http://192.168.1.10:8096"
API_KEY = nexus.config.get("apiKey")

def abspielen(item_id, name):
    nexus.player.play_url(
        f"{SERVER}/Videos/{item_id}/stream?static=true&api_key={API_KEY}",
        title=name, subtitle="Jellyfin", key=f"jellyfin:{item_id}",
    )

@nexus.on("player:close")
def geschlossen(data):
    if data.get("stream"):
        print("Stream beendet bei", round(data.time), "Sekunden:", data.stream.key)
```

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
- **Datei installieren**: eine einzelne `.js`- oder `.py`-Datei wird zu einem Plugin (Manifest wird automatisch erzeugt).
- Oder den Ordner selbst nach `%APPDATA%\de.nexus.anime\plugins\` kopieren und **Neu laden** klicken.
- **Entfernen** verschiebt den Plugin-Ordner in den Papierkorb und löscht die gespeicherten Plugin-Daten.
