# Anime Gallery (CustomTkinter)

Lokale Anime-Mediathek: Suche & Metadaten über AniList, Kachel-Bibliothek mit
Staffeln/Episoden, eingebetteter Player (mpv oder VLC) für lokale Dateien und
HLS-Streams.

## Starten

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m anime_gallery
```

**Player-Backend (Windows):** mindestens eines davon wird gebraucht:

- **mpv (empfohlen):** `libmpv-2.dll` (z. B. aus den „mpv-dev“-Builds von
  shinchiro auf SourceForge/GitHub) nach `bin/` in diesem Projektordner oder in
  einen Ordner im `PATH` legen. Python und DLL müssen beide 64-Bit sein.
- **VLC:** VLC Media Player (64-Bit) installieren – `python-vlc` findet ihn
  automatisch.

Ohne Backend läuft die App trotzdem; der Player zeigt dann einen Hinweis.

## Architektur

```
anime_gallery/
├── core/                  # UI-unabhängig
│   ├── async_runner.py    # asyncio-Loop im Hintergrund-Thread → Callbacks im Tk-Thread
│   ├── http.py            # gemeinsamer httpx.AsyncClient
│   ├── models.py          # Series › Season › Episode, AnimeSummary/Details
│   └── config.py          # Pfade (%APPDATA%\AnimeGallery)
├── services/              # Geschäftslogik, austauschbar über Interfaces
│   ├── metadata.py        # MetadataProvider (ABC) ← AniListProvider (GraphQL)
│   ├── images.py          # Cover-Download, Disk- + LRU-Cache, Skalierung off-thread
│   ├── library.py         # LibraryRepository (JSON, atomar) + Ordner-Scan
│   └── sources.py         # StreamResolver (ABC) ← LocalFile, DirectUrl; ResolverChain
├── player/
│   └── backends.py        # PlayerBackend (ABC) ← MpvBackend, VlcBackend (winfo_id-Embedding)
└── ui/
    ├── app.py             # Composition Root, Navigation mit History, Sidebar, Statusleiste
    ├── context.py         # AppContext (Dependency Injection) + View-Lebenszyklus
    ├── theme.py           # Design-Tokens
    ├── widgets.py         # CoverCard, CoverGrid (responsiv, lazy Cover)
    └── views/             # search, library, detail, player
```

### Datenfluss

```
UI-Event ──► runner.submit(coroutine) ──► Hintergrund-Loop (httpx, Dateisystem, PIL)
                                                │
Tk-Mainloop ◄── Queue (alle 16 ms geleert) ◄────┘   on_done / on_error
```

- **Kein Tk-Aufruf außerhalb des Hauptthreads.** Alles Langsame (Netz, Bilder
  dekodieren, Ordner scannen) läuft im `AsyncRunner`; Ergebnisse kommen über
  eine Queue zurück.
- **Veraltete Antworten** werden über Generationszähler verworfen (Live-Suche,
  Detailansicht), damit schnelles Tippen/Navigieren nichts durcheinanderbringt.
- **Staffeln:** Bei AniList ist jede Staffel ein eigener Eintrag. Eine `Series`
  bündelt sie; über „＋ Staffel / Verwandtes hinzufügen“ werden Fortsetzungen
  und Vorgänger (AniList-Relations) als Staffel eingehängt.

### Erweiterungspunkte

| Was                         | Wie                                                            |
| --------------------------- | -------------------------------------------------------------- |
| Weiterer Metadaten-Anbieter | `MetadataProvider` implementieren, in `ui/app.py` eintragen     |
| Eigener Medienserver        | `StreamResolver` implementieren (z. B. Jellyfin-API → HLS-URL)  |
| Anderer Player              | `PlayerBackend` implementieren, an `create_backend()` übergeben |
| SQLite statt JSON           | Klasse mit Schnittstelle von `LibraryRepository` ersetzen       |

## Bedienung

- **Suche:** tippen (400 ms Debounce) oder Enter → Kachel anklicken.
- **Detail:** „Zur Bibliothek“, „Ordner verknüpfen …“ (erkennt `S01E05`,
  `Ep 5`, `Titel - 05`, `[Gruppe] Titel 05 (1080p)`), pro Folge „URL“ für
  einen HLS-Link, ▶ oder Doppelklick zum Abspielen.
- **Quellen:** eigenen Link mit Platzhaltern eintragen, z. B.
  `https://mein-server/anime/{slug}/S{season}E{episode:02d}.m3u8`. Beim
  Abspielen wird der Link pro Folge ausgefüllt und geprüft; die erste
  erreichbare Quelle gewinnt. Gespeichert in `%APPDATA%\AnimeGallery\sources.json`.
- **Player:** Leertaste Pause, ←/→ ±10 s, `F` Vollbild, `Esc` Vollbild
  verlassen. Ab 90 % gilt eine Folge als gesehen.
