# NEXUS ANIME

Persönliche Anime-Bibliothek für Windows. NEXUS ANIME findet deine vorhandenen Videodateien, erkennt Serien, Staffeln und Episoden, zeigt sie mit Covern an und spielt sie im integrierten Player ab. Deine Dateien bleiben normale Dateien an ihrem Ort: Die App verschiebt, benennt und löscht nichts ohne deine ausdrückliche Bestätigung.

## Installation

Nach dem Build liegen die Installationsdateien hier:

- `src-tauri\target\release\bundle\nsis\NEXUS ANIME_1.0.0_x64-setup.exe` (empfohlen)
- `src-tauri\target\release\bundle\msi\NEXUS ANIME_1.0.0_x64_de-DE.msi`

Voraussetzung ist die Microsoft Edge WebView2 Runtime. Sie ist unter Windows 10/11 vorinstalliert; falls nicht, installiert das Setup sie automatisch.

## Erste Schritte

1. App starten → **Ersten Ordner hinzufügen** (beliebig viele Ordner und Laufwerke, auch externe Festplatten).
2. Der Scan läuft im Hintergrund und kann jederzeit abgebrochen werden.
3. Cover, Banner und Beschreibungen werden optional von AniList geladen und lokal gespeichert.
4. Nicht eindeutig erkannte Dateien landen unter **Mehr → Unsortierte Dateien** und können dort Serien zugeordnet werden.

Ordner und Videos lassen sich auch per Drag-and-drop aus dem Windows-Explorer ins Fenster ziehen.

## Funktionen im Überblick

| Bereich | Funktionen |
|---|---|
| Bibliothek | Startseite mit „Weiter ansehen“, zuletzt hinzugefügt/angesehen, Favoriten, ungesehene Folgen, Genre-Reihen; Raster mit Filtern, Sortierung und persönlicher Reihenfolge (Drag-and-drop) |
| Scan | Mehrere Quellordner, Unterordner, inkrementell, verschobene/umbenannte Dateien werden erkannt, nicht angeschlossene Laufwerke werden als „nicht verfügbar“ markiert statt gelöscht, Fortschritt & Abbrechen, optionale Ordnerüberwachung und Intervall-Scan |
| Erkennung | `S01E02`, `1x02`, `Staffel 2 Folge 4`, `Name - 1025`, `Name 03`, Fansub-Namen mit `[Gruppe]`/`[1080p]`/CRC, Ordnerkontext für `02.mp4`/`S1 Ep2.mp4`, Specials/OVAs/Filme, Mehrteiler, Versionen (`05v2`), Sprach- und Untertitelhinweise |
| Detailseite | Banner, Cover, Beschreibung, Genres, Statistiken, Staffel-Reiter, Episoden mit Vorschaubild, Laufzeit und Fortschritt, Drag-and-drop zwischen Staffeln, Mehrfachauswahl |
| Windows | Im Standardplayer öffnen, im Explorer anzeigen (Datei markiert), Ordner öffnen, Pfad kopieren, Dateieigenschaften inkl. MKV-Spuren |
| Player | Eigene Stream-Links (Jellyfin, Plex, NAS – MP4/WebM/MKV und HLS) über **Mehr → Stream-Link abspielen**, Play/Pause, ±10 s, Lautstärke, Geschwindigkeit, Vollbild, Fortsetzen, „Nächste Folge“ mit Countdown, Untertitel (SRT/ASS/VTT neben der Datei, eingebettete MKV-Textuntertitel, eigene Datei laden), Audiospuren, frei belegbare Tastenkürzel |
| Dateiverwaltung | Optionaler Bibliotheksordner (`Serie\Staffel 01\Serie - S01E01.mp4`), Kopieren oder Verschieben **nur nach Vorschau**, nie überschreiben, Datenbank-Backup vorher; Löschen einer Datei nur über den Papierkorb mit Eingabe des Dateinamens |
| Plugins | Eigene Plugins in JavaScript oder Python (Suchquellen für „Entdecken“ – z. B. das Beispiel [Jellyfin](examples/plugins/jellyfin-quelle) –, Stream-Resolver wie der [Stream-Extractor](examples/plugins/stream-extractor) für Webseiten-Links, Seiten, Menüeinträge, Startseiten-Bereiche, Player-Knöpfe, Tastenkürzel, Themes, Ereignisse, HTTP, Dateien, Programme, SQL) und eingebaute Plugins, alle unter **Einstellungen → Plugins** schaltbar – Anleitung in [PLUGINS.md](PLUGINS.md) |
| Daten | SQLite-Datenbank, Backup/Wiederherstellen, JSON-Export/-Import, Cache-Verwaltung, Protokolle, Diagnose; keine Telemetrie |

## Tastenkürzel im Player (Standard)

| Taste | Aktion |
|---|---|
| Leertaste / K | Wiedergabe / Pause |
| ← / → | 10 Sekunden zurück / vor (mit Umschalt: 30 s) |
| ↑ / ↓ | Lauter / leiser |
| M | Stumm |
| F / Doppelklick | Vollbild |
| N / P | Nächste / vorherige Folge |
| C | Untertitel an/aus |
| [ / ] | Langsamer / schneller |
| 0–9 | Zu 0 %–90 % springen |
| Esc | Player schließen |

Alle Tasten sind unter **Einstellungen → Wiedergabe** änderbar.

## Hinweise zur Wiedergabe

Der integrierte Player nutzt die Medienwiedergabe von Windows WebView2 (Chromium):

- **Zuverlässig:** MP4/M4V mit H.264 und AAC, WEBM, MKV mit H.264/VP9/AV1 und AAC/Opus/MP3.
- **Ggf. nicht:** HEVC/x265 (hängt von Hardware und Windows-Erweiterungen ab), AC3/DTS-Ton, 10-Bit-H.264, Bild-Untertitel (PGS/VobSub).

In diesen Fällen zeigt die App eine verständliche Meldung mit der Schaltfläche **„Im Standardplayer öffnen“**. Damit wird die Originaldatei ohne Kopie mit deinem Windows-Standardprogramm geöffnet (z. B. VLC oder mpv).

libmpv wurde bewusst nicht eingebettet: In einer WebView-Oberfläche lässt es sich nur über ein separates natives Fenster einbinden, was Overlays, Animationen und das einheitliche Design stark einschränkt. Für die seltenen Codecs ist der Standardplayer der zuverlässigere Weg.

## Speicherorte

- Datenbank, Cover, Vorschaubilder, Protokolle, Backups: `%APPDATA%\de.nexus.anime`
- Der Ort der Datenbank lässt sich unter **Einstellungen → Daten & Datenschutz** ändern.

## Entwicklung

Voraussetzungen: Node.js, Rust (MSVC), Visual Studio Build Tools.

Am einfachsten: **`Entwicklung starten.bat`** im Projektordner doppelklicken. Die App startet direkt aus den Quelldateien – Änderungen an `src\` erscheinen sofort, Änderungen an `src-tauri\` werden automatisch neu übersetzt. Vorher die installierte NEXUS ANIME schließen.

Oder von Hand:

```bash
npm install
```

```bash
npm run tauri dev
```

```bash
npm run tauri build
```

Tests der Dateinamen-Erkennung und weiterer Backend-Module:

```bash
cd src-tauri && cargo test --lib
```

### Aufbau

```
src/                 React + TypeScript (Oberfläche)
  pages/             Startseite, Bibliothek, Detailseite, Unsortiert, Einstellungen …
  player/            Integrierter Videoplayer
  components/        Cover, Karten, Dialoge, Kontextmenüs
  i18n.ts            Deutsche und englische Texte
src-tauri/src/       Rust-Backend
  parser.rs          Dateinamen-/Ordneranalyse (isoliert getestet)
  scanner.rs         Inkrementeller Scan
  db.rs              SQLite-Schema und Abfragen
  metadata.rs        AniList-Anbindung (optional, nur Titel werden übertragen)
  media.rs           Streaming der Originaldateien (HTTP-Range) über nexus://
  subtitles.rs       SRT/ASS/VTT und MKV-Untertitel → WebVTT
  fileops.rs         Kopieren/Verschieben mit Vorschau
  system.rs          Explorer/Standardplayer, Backup, Export, Diagnose
  watcher.rs         Ordnerüberwachung und Intervall-Scan
```

Metadaten: [AniList](https://anilist.co), öffentliche GraphQL-API, gedrosselt auf unter 30 Anfragen pro Minute, Ergebnisse werden 14 Tage zwischengespeichert.
