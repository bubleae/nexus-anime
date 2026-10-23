//! Inkrementeller Scan der Quellordner. Läuft in einem eigenen Thread und meldet
//! den Fortschritt über das Event `scan://progress`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::db::{self, now};
use crate::error::{AppError, AppResult};
use crate::parser::{self, EpisodeKind, NameSource, AUTO_ASSIGN_THRESHOLD};
use crate::settings::Settings;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub running: bool,
    pub phase: String,
    pub trigger: String,
    pub current_source: Option<String>,
    pub current_path: Option<String>,
    pub files_found: u64,
    pub processed: u64,
    pub added: u64,
    pub updated: u64,
    pub moved: u64,
    pub missing: u64,
    pub unsorted: u64,
    pub unavailable_sources: Vec<String>,
    pub errors: Vec<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub cancelled: bool,
}

struct FoundFile {
    path: PathBuf,
    size: i64,
    mtime: i64,
    source_id: String,
    root: PathBuf,
}

const SKIP_DIRS: &[&str] = &["$recycle.bin", "system volume information", ".trash", ".thumbnails", "@eadir", "#recycle"];

pub fn start_scan(app: &AppHandle, source_ids: Option<Vec<String>>, trigger: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err(AppError::msg("Es läuft bereits ein Scan."));
    }
    state.scan_cancel.store(false, Ordering::SeqCst);
    let app = app.clone();
    let trigger = trigger.to_string();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let result = run_scan(&app, source_ids, &trigger);
        state.scanning.store(false, Ordering::SeqCst);
        match result {
            Ok(p) => {
                log::info!("Scan beendet: {} Dateien, {} neu, {} verschoben, {} fehlen", p.files_found, p.added, p.moved, p.missing);
                let _ = app.emit("scan://finished", &p);
                let settings = state.settings().unwrap_or_default();
                if settings.auto_metadata && !p.cancelled {
                    crate::metadata::start_auto_fetch(&app);
                }
            }
            Err(e) => {
                log::error!("Scan fehlgeschlagen: {e}");
                let mut p = state.last_scan_progress.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
                p.running = false;
                p.phase = "error".into();
                p.errors.push(e.to_string());
                p.finished_at = Some(now());
                let _ = app.emit("scan://finished", &p);
            }
        }
    });
    Ok(())
}

fn emit(app: &AppHandle, p: &ScanProgress) {
    if let Ok(mut g) = app.state::<AppState>().last_scan_progress.lock() {
        *g = Some(p.clone());
    }
    let _ = app.emit("scan://progress", p);
}

fn file_info(path: &Path) -> Option<(i64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some((m.len() as i64, mtime))
}

fn is_excluded(path: &Path, excluded: &[String]) -> bool {
    let p = path.to_string_lossy().to_lowercase();
    excluded.iter().any(|e| {
        let e = e.trim_end_matches(['\\', '/']).to_lowercase();
        !e.is_empty() && (p == e || p.starts_with(&format!("{e}\\")) || p.starts_with(&format!("{e}/")))
    })
}

fn run_scan(app: &AppHandle, only: Option<Vec<String>>, trigger: &str) -> AppResult<ScanProgress> {
    let state = app.state::<AppState>();
    let cancel = state.scan_cancel.clone();
    let mut conn = db::open(&state.db_path)?;
    let settings = crate::settings::load(&conn)?;
    let started = now();
    conn.execute("INSERT INTO scan_history(started_at, status, trigger) VALUES(?1, 'running', ?2)", params![started, trigger])?;
    let history_id = conn.last_insert_rowid();

    let mut p = ScanProgress { running: true, phase: "discover".into(), trigger: trigger.into(), started_at: started.clone(), ..Default::default() };
    emit(app, &p);

    // ---------- Phase 1: Quellordner durchsuchen ----------
    let sources: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, path FROM sources WHERE enabled = 1")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().filter(|(id, _)| only.as_ref().map(|o| o.contains(id)).unwrap_or(true)).collect()
    };

    let mut found: Vec<FoundFile> = Vec::new();
    let mut scanned_sources: Vec<String> = Vec::new();
    let mut last_emit = Instant::now();
    for (source_id, source_path) in &sources {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let root = PathBuf::from(source_path);
        p.current_source = Some(source_path.clone());
        if !root.is_dir() {
            // Laufwerk nicht angeschlossen: Einträge behalten, nur als nicht verfügbar markieren
            conn.execute("UPDATE sources SET available = 0 WHERE id = ?1", params![source_id])?;
            conn.execute("UPDATE episodes SET available = 0 WHERE source_id = ?1", params![source_id])?;
            p.unavailable_sources.push(source_path.clone());
            log::warn!("Quellordner nicht erreichbar: {source_path}");
            continue;
        }
        conn.execute("UPDATE sources SET available = 1 WHERE id = ?1", params![source_id])?;
        scanned_sources.push(source_id.clone());
        let walker = WalkDir::new(&root).follow_links(false).into_iter().filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_lowercase();
            if e.file_type().is_dir() && (SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.')) {
                return false;
            }
            !is_excluded(e.path(), &settings.excluded_paths)
        });
        for entry in walker {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            match entry {
                Ok(e) => {
                    if !e.file_type().is_file() || !parser::is_video_file(e.path()) {
                        continue;
                    }
                    let (size, mtime) = match e.metadata() {
                        Ok(m) => (m.len() as i64, m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)),
                        Err(err) => {
                            push_err(&mut p, format!("{}: {err}", e.path().display()));
                            continue;
                        }
                    };
                    // Unvollständige Downloads überspringen
                    if size == 0 {
                        continue;
                    }
                    found.push(FoundFile { path: e.into_path(), size, mtime, source_id: source_id.clone(), root: root.clone() });
                    p.files_found += 1;
                    if last_emit.elapsed().as_millis() > 150 {
                        p.current_path = found.last().map(|f| f.path.to_string_lossy().to_string());
                        emit(app, &p);
                        last_emit = Instant::now();
                    }
                }
                Err(err) => push_err(&mut p, err.to_string()),
            }
        }
    }

    // ---------- Phase 2: Mit der Datenbank abgleichen ----------
    p.phase = "process".into();
    emit(app, &p);

    struct Known {
        id: String,
        size: i64,
        mtime: i64,
    }
    let mut known: HashMap<String, Known> = HashMap::new();
    let mut origins: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT id, file_path, file_size, file_mtime, origin_path FROM episodes")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let path: String = r.get(1)?;
            let origin: Option<String> = r.get(4)?;
            if let Some(o) = origin {
                origins.insert(o.to_lowercase());
            }
            known.insert(path.to_lowercase(), Known { id: r.get(0)?, size: r.get(2)?, mtime: r.get(3)? });
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut series_cache: HashMap<String, String> = HashMap::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let total = found.len();
    let mut i = 0;
    while i < total {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let tx = conn.transaction()?;
        let end = (i + 400).min(total);
        for f in &found[i..end] {
            let key = f.path.to_string_lossy().to_lowercase();
            if !seen_paths.insert(key.clone()) {
                continue; // überlappende Quellordner
            }
            p.processed += 1;
            let path_str = f.path.to_string_lossy().to_string();
            if let Some(k) = known.get(&key) {
                seen.insert(k.id.clone());
                if k.size != f.size || k.mtime != f.mtime {
                    tx.execute(
                        "UPDATE episodes SET file_size = ?1, file_mtime = ?2, available = 1, missing = 0, missing_since = NULL, duration = NULL, thumbnail_path = NULL, updated_at = ?3 WHERE id = ?4",
                        params![f.size, f.mtime, now(), k.id],
                    )?;
                    p.updated += 1;
                } else {
                    tx.execute("UPDATE episodes SET available = 1, missing = 0, missing_since = NULL WHERE id = ?1 AND (available = 0 OR missing = 1)", params![k.id])?;
                }
                continue;
            }
            if origins.contains(&key) {
                continue; // Original einer in die Bibliothek kopierten Datei
            }
            // Verschoben oder umbenannt? Gleiche Größe + gleicher Name bzw. gleiche Größe + Änderungszeit
            if let Some(id) = find_moved(&tx, f, &seen)? {
                tx.execute(
                    "UPDATE episodes SET file_path = ?1, file_name = ?2, source_id = ?3, file_mtime = ?4, available = 1, missing = 0, missing_since = NULL, updated_at = ?5 WHERE id = ?6",
                    params![path_str, f.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), f.source_id, f.mtime, now(), id],
                )?;
                seen.insert(id);
                p.moved += 1;
                continue;
            }
            let id = insert_new(&tx, f, &settings, &mut series_cache, &mut p)?;
            seen.insert(id);
        }
        tx.commit()?;
        i = end;
        p.current_path = found.get(end.saturating_sub(1)).map(|f| f.path.to_string_lossy().to_string());
        emit(app, &p);
    }

    // ---------- Phase 3: Fehlende Dateien markieren ----------
    if !cancel.load(Ordering::SeqCst) {
        p.phase = "verify".into();
        emit(app, &p);
        let ts = now();
        for sid in &scanned_sources {
            let ids: Vec<(String, String)> = {
                let mut stmt = conn.prepare("SELECT id, file_path FROM episodes WHERE source_id = ?1 AND missing = 0")?;
                let rows = stmt.query_map(params![sid], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for (id, path) in ids {
                if seen.contains(&id) {
                    continue;
                }
                // Ausgeschlossene, aber vorhandene Dateien gelten nicht als fehlend
                if Path::new(&path).exists() {
                    continue;
                }
                conn.execute("UPDATE episodes SET missing = 1, available = 0, missing_since = COALESCE(missing_since, ?1) WHERE id = ?2", params![ts, id])?;
                p.missing += 1;
            }
            conn.execute("UPDATE sources SET last_scan_at = ?1 WHERE id = ?2", params![ts, sid])?;
        }
        // Serien ohne Episoden, die der Scan selbst angelegt hat und die nie bearbeitet wurden, aufräumen
        conn.execute(
            "DELETE FROM series WHERE user_created = 0 AND favorite = 0 AND custom_cover = 0 AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = series.id)
             AND NOT EXISTS (SELECT 1 FROM assignment_rules r WHERE r.series_id = series.id)",
            [],
        )?;
    }

    p.cancelled = cancel.load(Ordering::SeqCst);
    p.running = false;
    p.phase = if p.cancelled { "cancelled".into() } else { "done".into() };
    p.finished_at = Some(now());
    p.current_path = None;
    conn.execute(
        "UPDATE scan_history SET finished_at = ?1, status = ?2, files_found = ?3, added = ?4, updated = ?5, moved = ?6, missing = ?7, unsorted = ?8, errors = ?9 WHERE id = ?10",
        params![p.finished_at, p.phase, p.files_found as i64, p.added as i64, p.updated as i64, p.moved as i64, p.missing as i64, p.unsorted as i64, serde_json::to_string(&p.errors)?, history_id],
    )?;
    emit(app, &p);
    Ok(p)
}

fn push_err(p: &mut ScanProgress, e: String) {
    if p.errors.len() < 200 {
        p.errors.push(e);
    }
}

fn find_moved(conn: &Connection, f: &FoundFile, seen: &HashSet<String>) -> AppResult<Option<String>> {
    let name = f.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut stmt = conn.prepare_cached(
        "SELECT id, file_path FROM episodes WHERE file_size = ?1 AND (file_name = ?2 COLLATE NOCASE OR file_mtime = ?3)",
    )?;
    let candidates = stmt
        .query_map(params![f.size, name, f.mtime], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, old) in candidates {
        if seen.contains(&id) {
            continue;
        }
        let old_path = Path::new(&old);
        // Nur übernehmen, wenn die alte Datei wirklich weg ist (Laufwerk vorhanden, Datei nicht)
        let drive_present = old_path.ancestors().last().map(|r| r.exists()).unwrap_or(false);
        if drive_present && !old_path.exists() {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn insert_new(
    conn: &Connection,
    f: &FoundFile,
    settings: &Settings,
    cache: &mut HashMap<String, String>,
    p: &mut ScanProgress,
) -> AppResult<String> {
    let parsed = parser::parse_path(&f.path, Some(&f.root));
    let ts = now();
    let mut series_id: Option<String> = None;
    let mut season = parsed.season.map(|s| s as i64);
    let mut confidence = parsed.confidence as f64;

    // 1. Manuelle Ordnerregeln haben Vorrang
    if let Some((sid, rule_season)) = db::find_rule(conn, &f.path)? {
        series_id = Some(sid);
        if rule_season.is_some() {
            season = rule_season;
        }
        confidence = 1.0;
    } else if let Some(title) = &parsed.series_title {
        if parsed.confidence >= AUTO_ASSIGN_THRESHOLD {
            let norm = parser::normalize_title(title);
            if let Some(id) = cache.get(&norm) {
                series_id = Some(id.clone());
            } else if let Some(id) = db::find_series_by_alias(conn, title)? {
                cache.insert(norm, id.clone());
                series_id = Some(id);
            } else if let Some(id) = parsed.alt_title.as_deref().map(|a| db::find_series_by_alias(conn, a)).transpose()?.flatten() {
                db::add_alias(conn, title, &id)?;
                cache.insert(norm, id.clone());
                series_id = Some(id);
            } else {
                // Bei Ordnernamen sicherstellen, dass nicht nur ein generischer Name erkannt wurde
                let id = db::create_series(conn, title, parsed.alt_title.as_deref(), parsed.year)?;
                cache.insert(norm, id.clone());
                series_id = Some(id);
            }
        }
    }

    let kind = parsed.kind;
    let episode = parsed.episode.map(|e| e as i64).or(if kind == EpisodeKind::Movie && series_id.is_some() { Some(1) } else { None });
    let mut ignored = 0;
    if series_id.is_none() {
        p.unsorted += 1;
        if settings.unrecognized_handling == "ignore" {
            ignored = 1;
        }
    } else if settings.duplicate_handling == "ignore" {
        let dup: Option<String> = conn
            .query_row(
                "SELECT id FROM episodes WHERE series_id = ?1 AND COALESCE(season, 1) = COALESCE(?2, 1) AND episode = ?3 AND kind = ?4 AND ignored = 0 LIMIT 1",
                params![series_id, season, episode, kind.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        if dup.is_some() {
            ignored = 1;
        }
    }

    let id = db::new_id();
    let parsed_series = match parsed.name_source {
        NameSource::None => None,
        _ => parsed.series_title.clone(),
    };
    conn.execute(
        "INSERT INTO episodes(id, series_id, file_path, file_name, file_size, file_mtime, source_id, season, episode, episode_end, kind, title,
                              resolution, audio_hints, subtitle_hints, version, parsed_series, confidence, ignored, added_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)",
        params![
            id,
            series_id,
            f.path.to_string_lossy().to_string(),
            f.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            f.size,
            f.mtime,
            f.source_id,
            season,
            episode,
            parsed.episode_end.map(|e| e as i64),
            kind.as_str(),
            parsed.episode_title,
            parsed.resolution,
            serde_json::to_string(&parsed.audio_hints)?,
            serde_json::to_string(&parsed.subtitle_hints)?,
            parsed.version.map(|v| v as i64),
            parsed_series,
            confidence,
            ignored,
            ts,
        ],
    )?;
    p.added += 1;
    Ok(id)
}

/// Fügt einzelne Dateien hinzu (Dateidialog oder Drag-and-drop aus dem Explorer).
/// Liegt die Datei in keinem Quellordner, wird ihr Ordner als Quellordner registriert.
/// Mit `series_id` werden alle Dateien direkt dieser Serie zugeordnet (manuelle Zuordnung).
pub fn add_files(app: &AppHandle, paths: Vec<String>, series_id: Option<&str>) -> AppResult<(u64, u64)> {
    let state = app.state::<AppState>();
    let settings = state.settings()?;
    let mut conn = db::open(&state.db_path)?;
    let sources: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, path FROM sources")?;
        let r = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        r
    };
    let mut files: Vec<PathBuf> = Vec::new();
    for p in paths {
        let pb = PathBuf::from(&p);
        if pb.is_dir() {
            for e in WalkDir::new(&pb).into_iter().flatten() {
                if e.file_type().is_file() && parser::is_video_file(e.path()) {
                    files.push(e.into_path());
                }
            }
        } else if pb.is_file() && parser::is_video_file(&pb) {
            files.push(pb);
        }
    }
    let tx = conn.transaction()?;
    let mut added = 0;
    let mut skipped = 0;
    let mut cache = HashMap::new();
    let mut progress = ScanProgress::default();
    for path in files {
        let exists: Option<String> = tx.query_row("SELECT id FROM episodes WHERE file_path = ?1", params![path.to_string_lossy()], |r| r.get(0)).optional()?;
        if let Some(id) = exists {
            tx.execute("UPDATE episodes SET ignored = 0 WHERE id = ?1", params![id])?;
            if let Some(sid) = series_id {
                tx.execute("UPDATE episodes SET series_id = ?1, manual = 1, confidence = 1.0, updated_at = ?2 WHERE id = ?3", params![sid, now(), id])?;
            }
            skipped += 1;
            continue;
        }
        let lower = path.to_string_lossy().to_lowercase();
        let found_source = sources.iter().find(|(_, sp)| lower.starts_with(&format!("{}\\", sp.trim_end_matches('\\').to_lowercase())));
        let (source_id, root) = match found_source {
            Some((id, sp)) => (id.clone(), PathBuf::from(sp)),
            None => {
                let dir = path.parent().map(|d| d.to_path_buf()).unwrap_or_default();
                // Elternordner als Wurzel, damit der Ordnername als Serienname dienen kann
                let root = dir.parent().map(|d| d.to_path_buf()).unwrap_or(dir.clone());
                let existing: Option<String> = tx.query_row("SELECT id FROM sources WHERE path = ?1", params![dir.to_string_lossy()], |r| r.get(0)).optional()?;
                let id = match existing {
                    Some(id) => id,
                    None => {
                        let id = db::new_id();
                        tx.execute("INSERT INTO sources(id, path, kind, added_at) VALUES(?1, ?2, 'source', ?3)", params![id, dir.to_string_lossy(), now()])?;
                        id
                    }
                };
                (id, root)
            }
        };
        let Some((size, mtime)) = file_info(&path) else { continue };
        let f = FoundFile { path, size, mtime, source_id, root };
        let id = insert_new(&tx, &f, &settings, &mut cache, &mut progress)?;
        if let Some(sid) = series_id {
            tx.execute("UPDATE episodes SET series_id = ?1, manual = 1, ignored = 0, confidence = 1.0 WHERE id = ?2", params![sid, id])?;
        }
        added += 1;
    }
    tx.commit()?;
    if settings.auto_metadata {
        crate::metadata::start_auto_fetch(app);
    }
    Ok((added, skipped))
}
