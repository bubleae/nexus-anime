//! Windows-Aktionen (Standardplayer, Explorer), Backups, Export/Import, Cache und Diagnose.

use rusqlite::{params, Connection, MAIN_DB};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::db::{self, now};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Prüft, ob eine Datei erreichbar ist, und liefert sonst eine verständliche Meldung.
pub fn ensure_exists(path: &Path) -> AppResult<()> {
    if path.exists() {
        return Ok(());
    }
    let root = path.ancestors().last().map(|p| p.to_path_buf()).unwrap_or_default();
    if !root.as_os_str().is_empty() && !root.exists() {
        return Err(AppError::msg(format!(
            "Das Laufwerk {} ist nicht angeschlossen. Schließe die Festplatte an und versuche es erneut.",
            root.display()
        )));
    }
    Err(AppError::msg(format!(
        "Die Datei wurde nicht gefunden:\n{}\nSie wurde möglicherweise verschoben, umbenannt oder gelöscht. Ein neuer Scan aktualisiert die Bibliothek.",
        path.display()
    )))
}

pub fn open_default(path: &Path) -> AppResult<()> {
    ensure_exists(path)?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| AppError::msg(format!("Datei konnte nicht geöffnet werden: {e}")))
}

pub fn reveal(path: &Path) -> AppResult<()> {
    ensure_exists(path)?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| AppError::msg(format!("Explorer konnte nicht geöffnet werden: {e}")))
}

pub fn open_folder(path: &Path) -> AppResult<()> {
    let dir = if path.is_dir() { path.to_path_buf() } else { path.parent().map(|p| p.to_path_buf()).unwrap_or_default() };
    ensure_exists(&dir)?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| AppError::msg(format!("Ordner konnte nicht geöffnet werden: {e}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub kind: String,
    pub codec: String,
    pub language: Option<String>,
    pub name: Option<String>,
    pub detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProperties {
    pub file_name: String,
    pub path: String,
    pub folder: String,
    pub exists: bool,
    pub size: Option<u64>,
    pub format: String,
    pub mime: String,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub container_duration: Option<f64>,
    pub tracks: Vec<TrackInfo>,
    pub origin_path: Option<String>,
}

fn fmt_time(t: std::io::Result<std::time::SystemTime>) -> Option<String> {
    t.ok().map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%d.%m.%Y %H:%M").to_string())
}

pub fn properties(path: &Path, origin: Option<String>) -> FileProperties {
    let meta = std::fs::metadata(path).ok();
    let mut tracks = vec![];
    let mut duration = None;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if meta.is_some() && (ext == "mkv" || ext == "webm") {
        if let Ok(f) = std::fs::File::open(path) {
            if let Ok(mkv) = matroska_demuxer::MatroskaFile::open(std::io::BufReader::new(f)) {
                let scale = mkv.info().timestamp_scale().get() as f64;
                duration = mkv.info().duration().map(|d| d * scale / 1e9);
                for t in mkv.tracks() {
                    use matroska_demuxer::TrackType::*;
                    let kind = match t.track_type() {
                        Video => "Video",
                        Audio => "Audio",
                        Subtitle => "Untertitel",
                        _ => continue,
                    };
                    let detail = match (t.video(), t.audio()) {
                        (Some(v), _) => Some(format!("{}×{}", v.pixel_width(), v.pixel_height())),
                        (_, Some(a)) => Some(format!("{} Kanäle, {} Hz", a.channels(), a.sampling_frequency() as u64)),
                        _ => None,
                    };
                    tracks.push(TrackInfo {
                        kind: kind.into(),
                        codec: t.codec_id().to_string(),
                        language: t.language_bcp47().or(t.language()).map(String::from),
                        name: t.name().map(String::from),
                        detail,
                    });
                }
            }
        }
    }
    FileProperties {
        file_name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        path: path.to_string_lossy().to_string(),
        folder: path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        exists: meta.is_some(),
        size: meta.as_ref().map(|m| m.len()),
        format: ext.to_uppercase(),
        mime: crate::media::mime_for(path).to_string(),
        created: meta.as_ref().and_then(|m| fmt_time(m.created())),
        modified: meta.as_ref().and_then(|m| fmt_time(m.modified())),
        container_duration: duration,
        tracks,
        origin_path: origin,
    }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

pub fn backup_to(state: &AppState, dest: Option<PathBuf>) -> AppResult<String> {
    let dest = match dest {
        Some(d) => d,
        None => {
            std::fs::create_dir_all(state.backups_dir())?;
            state.backups_dir().join(format!("nexus-backup-{}.db", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")))
        }
    };
    let conn = state.db()?;
    conn.backup(MAIN_DB, &dest, None)?;
    // Alte automatische Backups begrenzen (max. 15)
    if let Ok(rd) = std::fs::read_dir(state.backups_dir()) {
        let mut files: Vec<_> = rd.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("nexus-backup-")).map(|e| e.path()).collect();
        files.sort();
        while files.len() > 15 {
            let _ = std::fs::remove_file(files.remove(0));
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

pub fn restore_backup(state: &AppState, src: &Path) -> AppResult<()> {
    let check = Connection::open(src)?;
    let ok: i64 = check
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('series','episodes','sources')", [], |r| r.get(0))
        .unwrap_or(0);
    drop(check);
    if ok < 3 {
        return Err(AppError::msg("Die gewählte Datei ist kein gültiges NEXUS-ANIME-Backup."));
    }
    // Sicherheitskopie des aktuellen Stands
    backup_to(state, None)?;
    let mut conn = state.db()?;
    conn.restore(MAIN_DB, src, None::<fn(rusqlite::backup::Progress)>)?;
    db::migrate(&conn)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Export / Import (JSON, unabhängig vom Datenbankformat)
// ---------------------------------------------------------------------------

fn table_json(conn: &Connection, sql: &str) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map([], |r| {
            let mut m = serde_json::Map::new();
            for (i, c) in cols.iter().enumerate() {
                let v: rusqlite::types::Value = r.get(i)?;
                let j = match v {
                    rusqlite::types::Value::Null => Value::Null,
                    rusqlite::types::Value::Integer(n) => json!(n),
                    rusqlite::types::Value::Real(f) => json!(f),
                    rusqlite::types::Value::Text(t) => json!(t),
                    rusqlite::types::Value::Blob(_) => Value::Null,
                };
                m.insert(c.clone(), j);
            }
            Ok(Value::Object(m))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn export_library(state: &AppState, dest: &Path) -> AppResult<()> {
    let conn = state.db()?;
    let data = json!({
        "format": "nexus-anime-export",
        "version": 1,
        "exportedAt": now(),
        "sources": table_json(&conn, "SELECT * FROM sources")?,
        "series": table_json(&conn, "SELECT * FROM series")?,
        "aliases": table_json(&conn, "SELECT * FROM series_aliases")?,
        "episodes": table_json(&conn, "SELECT * FROM episodes")?,
        "rules": table_json(&conn, "SELECT * FROM assignment_rules")?,
        "seasonNames": table_json(&conn, "SELECT * FROM season_names")?,
        "settings": table_json(&conn, "SELECT * FROM settings")?,
    });
    std::fs::write(dest, serde_json::to_vec_pretty(&data)?)?;
    Ok(())
}

fn insert_rows(conn: &Connection, table: &str, rows: &[Value], conflict: &str) -> AppResult<usize> {
    let mut n = 0;
    for row in rows {
        let Some(obj) = row.as_object() else { continue };
        let cols: Vec<&String> = obj.keys().collect();
        let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "INSERT {conflict} INTO {table}({}) VALUES({})",
            cols.iter().map(|c| format!("\"{}\"", c.replace('"', ""))).collect::<Vec<_>>().join(","),
            placeholders.join(",")
        );
        let values: Vec<rusqlite::types::Value> = cols
            .iter()
            .map(|c| match &obj[*c] {
                Value::Null => rusqlite::types::Value::Null,
                Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
                Value::Number(x) => x.as_i64().map(rusqlite::types::Value::Integer).unwrap_or(rusqlite::types::Value::Real(x.as_f64().unwrap_or(0.0))),
                Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                other => rusqlite::types::Value::Text(other.to_string()),
            })
            .collect();
        n += conn.execute(&sql, rusqlite::params_from_iter(values))?;
    }
    Ok(n)
}

pub fn import_library(state: &AppState, src: &Path) -> AppResult<usize> {
    let data: Value = serde_json::from_slice(&std::fs::read(src)?)?;
    if data["format"] != "nexus-anime-export" {
        return Err(AppError::msg("Die Datei ist kein NEXUS-ANIME-Export."));
    }
    backup_to(state, None)?;
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    let empty = vec![];
    let mut n = 0;
    n += insert_rows(&tx, "sources", data["sources"].as_array().unwrap_or(&empty), "OR IGNORE")?;
    n += insert_rows(&tx, "series", data["series"].as_array().unwrap_or(&empty), "OR REPLACE")?;
    n += insert_rows(&tx, "series_aliases", data["aliases"].as_array().unwrap_or(&empty), "OR REPLACE")?;
    n += insert_rows(&tx, "episodes", data["episodes"].as_array().unwrap_or(&empty), "OR REPLACE")?;
    n += insert_rows(&tx, "assignment_rules", data["rules"].as_array().unwrap_or(&empty), "OR REPLACE")?;
    n += insert_rows(&tx, "season_names", data["seasonNames"].as_array().unwrap_or(&empty), "OR REPLACE")?;
    n += insert_rows(&tx, "settings", data["settings"].as_array().unwrap_or(&empty), "OR REPLACE")?;
    tx.commit()?;
    Ok(n)
}

// ---------------------------------------------------------------------------
// Cache, Protokolle, Diagnose
// ---------------------------------------------------------------------------

fn dir_size(p: &Path) -> u64 {
    walkdir::WalkDir::new(p).into_iter().flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}

pub fn clear_cache(state: &AppState, kind: &str) -> AppResult<()> {
    let conn = state.db()?;
    match kind {
        "metadata" => {
            conn.execute("DELETE FROM metadata_cache", [])?;
        }
        "thumbnails" => {
            let _ = std::fs::remove_dir_all(state.thumbs_dir());
            conn.execute("UPDATE episodes SET thumbnail_path = NULL", [])?;
        }
        "subtitles" => {
            let _ = std::fs::remove_dir_all(state.subs_dir());
        }
        _ => return Err(AppError::msg("Unbekannter Cache")),
    }
    Ok(())
}

pub fn read_logs(state: &AppState) -> AppResult<String> {
    let p = state.logs_dir().join("nexus.log");
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    let len = text.len();
    let start = len.saturating_sub(200_000);
    let start = (start..len).find(|i| text.is_char_boundary(*i)).unwrap_or(len);
    Ok(text[start..].to_string())
}

pub fn diagnostics(app: &AppHandle) -> AppResult<Value> {
    let state = app.state::<AppState>();
    let conn = state.db()?;
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
    let history = table_json(&conn, "SELECT * FROM scan_history ORDER BY id DESC LIMIT 15")?;
    let ops = table_json(&conn, "SELECT * FROM file_operations ORDER BY id DESC LIMIT 30")?;
    Ok(json!({
        "appVersion": app.package_info().version.to_string(),
        "webviewVersion": tauri::webview_version().unwrap_or_default(),
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "dataDir": state.data_dir,
        "databasePath": state.db_path,
        "databaseSize": std::fs::metadata(&state.db_path).map(|m| m.len()).unwrap_or(0),
        "imagesSize": dir_size(&state.images_dir()),
        "thumbsSize": dir_size(&state.thumbs_dir()),
        "subtitlesSize": dir_size(&state.subs_dir()),
        "series": count("SELECT COUNT(*) FROM series"),
        "episodes": count("SELECT COUNT(*) FROM episodes WHERE ignored = 0"),
        "unsorted": count("SELECT COUNT(*) FROM episodes WHERE series_id IS NULL AND ignored = 0"),
        "unavailable": count("SELECT COUNT(*) FROM episodes WHERE (available = 0 OR missing = 1) AND ignored = 0"),
        "hidden": count("SELECT COUNT(*) FROM episodes WHERE ignored = 1"),
        "metadataCacheEntries": count("SELECT COUNT(*) FROM metadata_cache"),
        "scanHistory": history,
        "fileOperations": ops,
    }))
}

/// Ort der Datenbank: entweder Standard (App-Datenordner) oder in `database_location.txt` hinterlegt.
pub fn resolve_db_path(config_dir: &Path, data_dir: &Path) -> PathBuf {
    if let Ok(s) = std::fs::read_to_string(config_dir.join("database_location.txt")) {
        let dir = PathBuf::from(s.trim());
        if !s.trim().is_empty() && dir.is_dir() {
            return dir.join("nexus.db");
        }
    }
    data_dir.join("nexus.db")
}

pub fn move_database(app: &AppHandle, new_dir: &Path) -> AppResult<String> {
    let state = app.state::<AppState>();
    std::fs::create_dir_all(new_dir)?;
    let dest = new_dir.join("nexus.db");
    if dest.exists() {
        return Err(AppError::msg("Im Zielordner existiert bereits eine nexus.db. Bitte einen leeren Ordner wählen oder das Backup wiederherstellen."));
    }
    {
        let conn = state.db()?;
        conn.backup(MAIN_DB, &dest, None)?;
    }
    let config = app.path().app_config_dir()?;
    std::fs::create_dir_all(&config)?;
    std::fs::write(config.join("database_location.txt"), new_dir.to_string_lossy().as_bytes())?;
    log::info!("Datenbank nach {} kopiert; aktiv nach Neustart", dest.display());
    Ok(dest.to_string_lossy().to_string())
}

pub fn record_ignored_restore(conn: &Connection, ids: &[String]) -> AppResult<()> {
    for id in ids {
        conn.execute("UPDATE episodes SET ignored = 0, updated_at = ?1 WHERE id = ?2", params![now(), id])?;
    }
    Ok(())
}
