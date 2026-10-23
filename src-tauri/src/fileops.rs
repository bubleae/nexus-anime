//! Optionale Organisation in einem zentralen Bibliotheksordner.
//!
//! Ablauf immer zweistufig: `plan` erzeugt eine Vorschau (nichts wird verändert),
//! erst `execute` mit den bestätigten Einträgen kopiert bzw. verschiebt Dateien.
//! Bestehende Dateien werden niemals überschrieben.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, now, Episode};
use crate::error::{AppError, AppResult};
use crate::settings::Settings;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub series_ids: Option<Vec<String>>,
    pub episode_ids: Option<Vec<String>>,
    pub mode: String,
    /// Nur Dateien, die noch nicht im Bibliotheksordner liegen
    #[serde(default)]
    pub only_outside: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOp {
    pub episode_id: String,
    pub series_title: String,
    pub from: String,
    pub to: String,
    pub size: i64,
    /// ok | exists | same | duplicate | unavailable | unassigned
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub mode: String,
    pub library_path: String,
    pub ops: Vec<PlannedOp>,
    pub total_size: i64,
    pub conflict_policy: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpProgress {
    pub running: bool,
    pub mode: String,
    pub total: usize,
    pub done: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
    pub current: Option<String>,
    pub backup: Option<String>,
}

pub fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { ' ' } else { c })
        .collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim_end_matches(['.', ' ']).to_string();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2"];
    if s.is_empty() || reserved.contains(&s.to_uppercase().as_str()) {
        format!("_{s}")
    } else {
        s
    }
}

fn target_for(e: &Episode, series_title: &str, settings: &Settings, library: &Path) -> PathBuf {
    let ext = Path::new(&e.file_name).extension().map(|x| x.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".into());
    let series_dir = library.join(sanitize(series_title));
    let season = e.season.unwrap_or(1);
    let (folder, season_num) = match e.kind.as_str() {
        "special" | "ova" | "extra" => ("Specials".to_string(), 0),
        "movie" => ("Filme".to_string(), 0),
        _ => (format!("Staffel {:02}", season), season),
    };
    let dir = if settings.season_folders { series_dir.join(folder) } else { series_dir };
    let name = if settings.auto_rename {
        let ep = e.episode.map(|n| if n >= 100 { format!("{n:03}") } else { format!("{n:02}") }).unwrap_or_else(|| "00".into());
        let ep = match e.episode_end {
            Some(end) => format!("{ep}-E{end:02}"),
            None => ep,
        };
        let mut n = settings
            .naming_scheme
            .replace("{series}", series_title)
            .replace("{season}", &format!("{season_num:02}"))
            .replace("{episode}", &ep)
            .replace("{title}", e.title.as_deref().unwrap_or(""))
            .replace("{resolution}", e.resolution.as_deref().unwrap_or(""));
        if e.kind == "movie" {
            n = match &e.title {
                Some(t) => format!("{series_title} - {t}"),
                None => format!("{series_title} - Film {}", e.episode.unwrap_or(1)),
            };
        }
        if let Some(v) = e.version.filter(|v| *v > 1) {
            n = format!("{n} (v{v})");
        }
        sanitize(n.trim().trim_end_matches(['-', ' ']))
    } else {
        sanitize(Path::new(&e.file_name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default().as_str())
    };
    dir.join(format!("{name}.{ext}"))
}

fn unique_path(p: &Path, taken: &HashSet<String>) -> PathBuf {
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let dir = p.parent().unwrap_or(Path::new(""));
    for i in 1..1000 {
        let c = dir.join(format!("{stem} ({i}).{ext}"));
        if !c.exists() && !taken.contains(&c.to_string_lossy().to_lowercase()) {
            return c;
        }
    }
    p.to_path_buf()
}

pub fn plan(app: &AppHandle, req: PlanRequest) -> AppResult<Plan> {
    let state = app.state::<AppState>();
    let settings = state.settings()?;
    let library = settings.library_path.clone().filter(|p| !p.trim().is_empty()).ok_or_else(|| AppError::msg("Bitte zuerst in den Einstellungen einen Bibliotheksordner festlegen."))?;
    let library_path = PathBuf::from(&library);
    if req.mode != "copy" && req.mode != "move" {
        return Err(AppError::msg("Unbekannte Dateioperation"));
    }
    let conn = state.db()?;
    let mut episodes: Vec<Episode> = vec![];
    if let Some(ids) = &req.series_ids {
        for id in ids {
            episodes.extend(db::series_episodes(&conn, id)?);
        }
    }
    if let Some(ids) = &req.episode_ids {
        for id in ids {
            if let Some(e) = db::get_episode(&conn, id)? {
                if !episodes.iter().any(|x| x.id == e.id) {
                    episodes.push(e);
                }
            }
        }
    }
    if req.series_ids.is_none() && req.episode_ids.is_none() {
        episodes = db::episodes_where(&conn, "e.series_id IS NOT NULL AND e.ignored = 0", db::EPISODE_ORDER, &[])?;
    }
    let lib_lower = library.trim_end_matches('\\').to_lowercase();
    let mut taken: HashSet<String> = HashSet::new();
    let mut ops = vec![];
    let mut total = 0;
    for e in episodes {
        let in_library = e.file_path.to_lowercase().starts_with(&format!("{lib_lower}\\"));
        if req.only_outside && in_library {
            continue;
        }
        let Some(series_title) = e.series_title.clone() else {
            ops.push(PlannedOp { episode_id: e.id.clone(), series_title: String::new(), from: e.file_path.clone(), to: String::new(), size: e.file_size, status: "unassigned".into() });
            continue;
        };
        let mut to = target_for(&e, &series_title, &settings, &library_path);
        let mut status = "ok";
        if !(e.available && !e.missing) || !Path::new(&e.file_path).exists() {
            status = "unavailable";
        } else if to.to_string_lossy().eq_ignore_ascii_case(&e.file_path) {
            status = "same";
        } else if taken.contains(&to.to_string_lossy().to_lowercase()) {
            status = "duplicate";
            to = unique_path(&to, &taken);
        } else if to.exists() {
            status = "exists";
            if settings.conflict_policy == "rename" {
                to = unique_path(&to, &taken);
            }
        }
        taken.insert(to.to_string_lossy().to_lowercase());
        if status == "ok" || status == "duplicate" || (status == "exists" && settings.conflict_policy == "rename") {
            total += e.file_size;
        }
        ops.push(PlannedOp { episode_id: e.id, series_title, from: e.file_path, to: to.to_string_lossy().to_string(), size: e.file_size, status: status.into() });
    }
    Ok(Plan { mode: req.mode, library_path: library, ops, total_size: total, conflict_policy: settings.conflict_policy })
}

/// Führt die bestätigten Operationen im Hintergrund aus.
pub fn execute(app: &AppHandle, mode: String, ops: Vec<PlannedOp>) -> AppResult<()> {
    let state = app.state::<AppState>();
    let settings = state.settings()?;
    let library = settings.library_path.clone().ok_or_else(|| AppError::msg("Kein Bibliotheksordner festgelegt"))?;
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let mut prog = OpProgress { running: true, mode: mode.clone(), total: ops.len(), ..Default::default() };
        if settings.backup_before_changes {
            match crate::system::backup_to(&state, None) {
                Ok(p) => prog.backup = Some(p),
                Err(e) => log::warn!("Backup vor Dateioperation fehlgeschlagen: {e}"),
            }
        }
        let library_source = db::open(&state.db_path).and_then(|c| ensure_library_source(&c, &library));
        let _ = app.emit("fileops://progress", &prog);
        for op in &ops {
            prog.current = Some(op.from.clone());
            let _ = app.emit("fileops://progress", &prog);
            let res = run_one(&state, &mode, op, library_source.as_ref().ok().map(|s| s.as_str()), &settings.conflict_policy);
            match res {
                Ok(true) => prog.done += 1,
                Ok(false) => prog.skipped += 1,
                Err(e) => {
                    log::error!("Dateioperation fehlgeschlagen ({}): {e}", op.from);
                    prog.failed.push(format!("{}: {e}", op.from));
                }
            }
        }
        prog.running = false;
        prog.current = None;
        let _ = app.emit("fileops://finished", &prog);
    });
    Ok(())
}

pub fn ensure_library_source(conn: &rusqlite::Connection, library: &str) -> AppResult<String> {
    if let Ok(id) = conn.query_row("SELECT id FROM sources WHERE path = ?1", params![library], |r| r.get::<_, String>(0)) {
        conn.execute("UPDATE sources SET kind = 'library' WHERE id = ?1", params![id])?;
        return Ok(id);
    }
    let id = db::new_id();
    conn.execute("INSERT INTO sources(id, path, kind, added_at) VALUES(?1, ?2, 'library', ?3)", params![id, library, now()])?;
    Ok(id)
}

fn run_one(state: &AppState, mode: &str, op: &PlannedOp, library_source: Option<&str>, policy: &str) -> AppResult<bool> {
    if !matches!(op.status.as_str(), "ok" | "duplicate" | "exists") || op.to.is_empty() {
        return Ok(false);
    }
    let from = PathBuf::from(&op.from);
    let mut to = PathBuf::from(&op.to);
    if !from.exists() {
        return Err(AppError::msg("Quelldatei nicht mehr vorhanden"));
    }
    if to.exists() {
        // Zwischen Vorschau und Ausführung entstanden – niemals überschreiben
        if policy == "rename" {
            to = unique_path(&to, &HashSet::new());
        } else {
            return Ok(false);
        }
    }
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let size = std::fs::metadata(&from)?.len();
    let status;
    if mode == "move" {
        match std::fs::rename(&from, &to) {
            Ok(_) => {}
            Err(_) => {
                // Anderes Laufwerk: kopieren, prüfen, dann Original entfernen
                std::fs::copy(&from, &to)?;
                let copied = std::fs::metadata(&to)?.len();
                if copied != size {
                    let _ = std::fs::remove_file(&to);
                    return Err(AppError::msg("Kopie unvollständig – Original wurde nicht entfernt"));
                }
                std::fs::remove_file(&from)?;
            }
        }
        status = "moved";
    } else {
        std::fs::copy(&from, &to)?;
        let copied = std::fs::metadata(&to)?.len();
        if copied != size {
            let _ = std::fs::remove_file(&to);
            return Err(AppError::msg("Kopie unvollständig"));
        }
        status = "copied";
    }
    let conn = state.db()?;
    let file_name = to.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if mode == "move" {
        conn.execute(
            "UPDATE episodes SET file_path = ?1, file_name = ?2, source_id = COALESCE(?3, source_id), available = 1, missing = 0, updated_at = ?4 WHERE id = ?5",
            params![to.to_string_lossy(), file_name, library_source, now(), op.episode_id],
        )?;
    } else {
        conn.execute(
            "UPDATE episodes SET file_path = ?1, file_name = ?2, origin_path = ?3, source_id = COALESCE(?4, source_id), available = 1, missing = 0, updated_at = ?5 WHERE id = ?6",
            params![to.to_string_lossy(), file_name, op.from, library_source, now(), op.episode_id],
        )?;
    }
    conn.execute(
        "INSERT INTO file_operations(executed_at, episode_id, op, from_path, to_path, status) VALUES(?1, ?2, ?3, ?4, ?5, 'ok')",
        params![now(), op.episode_id, status, op.from, to.to_string_lossy()],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_windows_names() {
        assert_eq!(sanitize("Re:Zero? <Season>"), "Re Zero Season");
        assert_eq!(sanitize("Name..."), "Name");
        assert_eq!(sanitize("CON"), "_CON");
    }
}
