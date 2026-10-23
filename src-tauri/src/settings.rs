//! Benutzereinstellungen. Werden als JSON in der Tabelle `settings` gespeichert.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    // Allgemein
    pub language: String,
    pub theme: String,
    pub accent: String,
    pub animations: bool,
    pub start_page: String,
    pub start_behavior: String,
    pub window_mode: String,
    // Bibliothek
    pub library_path: Option<String>,
    pub scan_on_start: bool,
    pub watch_folders: bool,
    pub scan_interval_minutes: u32,
    pub excluded_paths: Vec<String>,
    pub duplicate_handling: String,
    pub unrecognized_handling: String,
    pub missing_drive_behavior: String,
    // Dateiverwaltung
    pub file_mode: String,
    pub auto_rename: bool,
    pub naming_scheme: String,
    pub season_folders: bool,
    pub preview_file_ops: bool,
    pub conflict_policy: String,
    pub backup_before_changes: bool,
    // Wiedergabe
    pub default_volume: f64,
    pub default_speed: f64,
    pub auto_resume: bool,
    pub auto_next: bool,
    pub end_behavior: String,
    pub next_countdown_seconds: u32,
    pub mark_watched_percent: u32,
    pub subtitle_size: u32,
    pub subtitle_color: String,
    pub subtitle_background: bool,
    pub preferred_audio_lang: String,
    pub preferred_subtitle_lang: String,
    pub player_window_mode: String,
    pub generate_thumbnails: bool,
    pub shortcuts: BTreeMap<String, String>,
    // Metadaten
    pub auto_metadata: bool,
    pub title_language: String,
    pub cover_quality: String,
    // Datenschutz
    pub telemetry: bool,
}

pub fn default_shortcuts() -> BTreeMap<String, String> {
    [
        ("playPause", " "),
        ("seekForward", "ArrowRight"),
        ("seekBackward", "ArrowLeft"),
        ("volumeUp", "ArrowUp"),
        ("volumeDown", "ArrowDown"),
        ("mute", "m"),
        ("fullscreen", "f"),
        ("nextEpisode", "n"),
        ("previousEpisode", "p"),
        ("subtitles", "c"),
        ("speedUp", "]"),
        ("speedDown", "["),
        ("close", "Escape"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: "de".into(),
            theme: "dark".into(),
            accent: "violet".into(),
            animations: true,
            start_page: "home".into(),
            start_behavior: "startPage".into(),
            window_mode: "normal".into(),
            library_path: None,
            scan_on_start: true,
            watch_folders: false,
            scan_interval_minutes: 0,
            excluded_paths: vec![],
            duplicate_handling: "versions".into(),
            unrecognized_handling: "unsorted".into(),
            missing_drive_behavior: "keep".into(),
            file_mode: "reference".into(),
            auto_rename: true,
            naming_scheme: "{series} - S{season}E{episode}".into(),
            season_folders: true,
            preview_file_ops: true,
            conflict_policy: "skip".into(),
            backup_before_changes: true,
            default_volume: 0.8,
            default_speed: 1.0,
            auto_resume: true,
            auto_next: true,
            end_behavior: "countdown".into(),
            next_countdown_seconds: 10,
            mark_watched_percent: 90,
            subtitle_size: 100,
            subtitle_color: "#ffffff".into(),
            subtitle_background: true,
            preferred_audio_lang: "jpn".into(),
            preferred_subtitle_lang: "ger".into(),
            player_window_mode: "window".into(),
            generate_thumbnails: true,
            shortcuts: default_shortcuts(),
            auto_metadata: true,
            title_language: "romaji".into(),
            cover_quality: "extraLarge".into(),
            telemetry: false,
        }
    }
}

pub fn load(conn: &Connection) -> AppResult<Settings> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).optional()?;
    let mut s: Settings = raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
    // Neue Tastenkürzel ergänzen, ohne eigene Belegungen zu überschreiben
    for (k, v) in default_shortcuts() {
        s.shortcuts.entry(k).or_insert(v);
    }
    Ok(s)
}

pub fn save(conn: &Connection, s: &Settings) -> AppResult<()> {
    let v = serde_json::to_string(s)?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES('app', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![v],
    )?;
    Ok(())
}
