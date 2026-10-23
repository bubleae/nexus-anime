//! Tauri-Befehle: die Schnittstelle zwischen Oberfläche und Backend.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

use crate::db::{self, now, Episode, SeriesSummary, Source};
use crate::error::{AppError, AppResult};
use crate::fileops::{self, Plan, PlanRequest, PlannedOp};
use crate::metadata::{self, AnimeMatch};
use crate::scanner::{self, ScanProgress};
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::subtitles::{self, SubtitleTrack};
use crate::system;

type Cmd<T> = Result<T, AppError>;

// ---------------------------------------------------------------------------
// Start & Übersicht
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    settings: Settings,
    sources: Vec<Source>,
    scanning: bool,
    scan: Option<ScanProgress>,
    version: String,
    data_dir: String,
    database_path: String,
    unsorted_count: i64,
    unavailable_count: i64,
}

#[tauri::command(async)]
pub fn get_bootstrap(app: AppHandle, state: State<AppState>) -> Cmd<Bootstrap> {
    let conn = state.db()?;
    Ok(Bootstrap {
        settings: settings::load(&conn)?,
        sources: db::list_sources(&conn)?,
        scanning: state.is_scanning(),
        scan: state.last_scan_progress.lock().ok().and_then(|g| g.clone()),
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        database_path: state.db_path.to_string_lossy().to_string(),
        unsorted_count: conn.query_row("SELECT COUNT(*) FROM episodes WHERE series_id IS NULL AND ignored = 0", [], |r| r.get(0))?,
        unavailable_count: conn.query_row("SELECT COUNT(*) FROM episodes WHERE (available = 0 OR missing = 1) AND ignored = 0", [], |r| r.get(0))?,
    })
}

#[tauri::command(async)]
pub fn list_series(state: State<AppState>) -> Cmd<Vec<SeriesSummary>> {
    db::list_series(&*state.db()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDetail {
    series: SeriesSummary,
    episodes: Vec<Episode>,
    season_names: HashMap<i64, String>,
    folders: Vec<String>,
    links: Vec<crate::links::SeriesLink>,
}

#[tauri::command(async)]
pub fn get_series_detail(state: State<AppState>, id: String) -> Cmd<SeriesDetail> {
    let conn = state.db()?;
    let series = db::get_series(&conn, &id)?.ok_or_else(|| AppError::msg("Serie nicht gefunden"))?;
    let episodes = db::series_episodes(&conn, &id)?;
    let mut stmt = conn.prepare("SELECT season, title FROM season_names WHERE series_id = ?1")?;
    let season_names = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<HashMap<_, _>, _>>()?;
    let folders = series_folders(&episodes);
    let links = crate::links::list(&conn, &id)?;
    Ok(SeriesDetail { series, episodes, season_names, folders, links })
}

/// Ordner einer Serie, nach Häufigkeit sortiert. Staffelordner werden auf den Serienordner verdichtet.
fn series_folders(episodes: &[Episode]) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for e in episodes {
        let p = Path::new(&e.file_path);
        let Some(mut dir) = p.parent() else { continue };
        let name = dir.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if name.starts_with("staffel") || name.starts_with("season") || name.starts_with("specials") || name == "filme" || name.starts_with("s0") {
            if let Some(parent) = dir.parent() {
                dir = parent;
            }
        }
        *counts.entry(dir.to_string_lossy().to_string()).or_default() += 1;
    }
    let mut v: Vec<(String, usize)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v.into_iter().map(|(p, _)| p).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueItem {
    series: SeriesSummary,
    episode: Episode,
}

/// Pro Serie die Episode, mit der es weitergeht: angefangene Folge oder die nächste ungesehene.
#[tauri::command(async)]
pub fn get_continue_watching(state: State<AppState>, limit: Option<usize>) -> Cmd<Vec<ContinueItem>> {
    let conn = state.db()?;
    let series = db::list_series(&conn)?;
    let mut played: Vec<&SeriesSummary> = series.iter().filter(|s| s.last_played_at.is_some()).collect();
    played.sort_by(|a, b| b.last_played_at.cmp(&a.last_played_at));
    let mut out = vec![];
    for s in played {
        let eps = db::series_episodes(&conn, &s.id)?;
        let Some(last) = eps.iter().filter(|e| e.last_played_at.is_some()).max_by(|a, b| a.last_played_at.cmp(&b.last_played_at)) else { continue };
        let next = if !last.watched {
            Some(last.clone())
        } else {
            let idx = eps.iter().position(|e| e.id == last.id).unwrap_or(0);
            eps.iter().skip(idx + 1).find(|e| !e.watched && e.kind == last.kind).cloned()
        };
        if let Some(ep) = next {
            out.push(ContinueItem { series: s.clone(), episode: ep });
        }
        if out.len() >= limit.unwrap_or(30) {
            break;
        }
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn list_episodes(state: State<AppState>, filter: String, limit: Option<i64>) -> Cmd<Vec<Episode>> {
    let conn = state.db()?;
    let lim = limit.unwrap_or(500);
    let (w, o) = match filter.as_str() {
        "unsorted" => ("e.series_id IS NULL AND e.ignored = 0", "ORDER BY e.file_path COLLATE NOCASE"),
        "unavailable" => ("(e.available = 0 OR e.missing = 1) AND e.ignored = 0", "ORDER BY s.title, e.season, e.episode"),
        "hidden" => ("e.ignored = 1", "ORDER BY e.file_path COLLATE NOCASE"),
        "recentPlayed" => ("e.last_played_at IS NOT NULL AND e.ignored = 0", "ORDER BY e.last_played_at DESC"),
        "recentAdded" => ("e.ignored = 0 AND e.series_id IS NOT NULL", "ORDER BY e.added_at DESC"),
        "unwatched" => ("e.watched = 0 AND e.ignored = 0 AND e.series_id IS NOT NULL AND e.available = 1 AND e.missing = 0", "ORDER BY e.added_at DESC"),
        _ => return Err(AppError::msg("Unbekannter Filter")),
    };
    let order = format!("{o} LIMIT {lim}");
    db::episodes_where(&conn, w, &order, &[])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    series: Vec<SeriesSummary>,
    episodes: Vec<Episode>,
}

#[tauri::command(async)]
pub fn search(state: State<AppState>, query: String) -> Cmd<SearchResult> {
    let conn = state.db()?;
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult { series: vec![], episodes: vec![] });
    }
    let norm = crate::parser::normalize_title(q);
    let like = format!("%{}%", q.replace('%', "").replace('_', "\\_"));
    let like_norm = format!("%{norm}%");
    let all = db::list_series(&conn)?;
    let alias_hits: Vec<String> = {
        let mut stmt = conn.prepare("SELECT DISTINCT series_id FROM series_aliases WHERE alias_norm LIKE ?1")?;
        let r = stmt.query_map(params![like_norm], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
        r
    };
    let series: Vec<SeriesSummary> = all
        .into_iter()
        .filter(|s| {
            let t = crate::parser::normalize_title(&s.title);
            let a = s.alt_title.as_deref().map(crate::parser::normalize_title).unwrap_or_default();
            t.contains(&norm) || a.contains(&norm) || alias_hits.contains(&s.id) || s.genres.iter().any(|g| g.eq_ignore_ascii_case(q))
        })
        .collect();

    // "S01E05", "1x05" oder "Folge 5" → nach Staffel/Episodennummer suchen
    let parsed = crate::parser::parse_path(Path::new(&format!("{q}.mp4")), None);
    let mut episodes = db::episodes_where(
        &conn,
        "e.ignored = 0 AND (e.title LIKE ?1 ESCAPE '\\' OR e.file_name LIKE ?1 ESCAPE '\\' OR s.title LIKE ?1 ESCAPE '\\')",
        "ORDER BY s.title, e.season, e.episode LIMIT 60",
        &[&like],
    )?;
    if let Some(ep) = parsed.episode {
        let name = parsed.series_title.clone().map(|t| format!("%{t}%")).unwrap_or("%".into());
        let extra = db::episodes_where(
            &conn,
            "e.ignored = 0 AND e.episode = ?1 AND (?2 IS NULL OR COALESCE(e.season, 1) = ?2) AND (s.title LIKE ?3 OR s.alt_title LIKE ?3)",
            "ORDER BY s.title LIMIT 40",
            &[&(ep as i64), &parsed.season.map(|s| s as i64), &name],
        )?;
        for e in extra {
            if !episodes.iter().any(|x| x.id == e.id) {
                episodes.insert(0, e);
            }
        }
    }
    Ok(SearchResult { series, episodes })
}

// ---------------------------------------------------------------------------
// Serien bearbeiten
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn set_favorite(state: State<AppState>, id: String, favorite: bool) -> Cmd<()> {
    state.db()?.execute("UPDATE series SET favorite = ?1, updated_at = ?2 WHERE id = ?3", params![favorite as i64, now(), id])?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPatch {
    title: Option<String>,
    alt_title: Option<Option<String>>,
    description: Option<Option<String>>,
    year: Option<Option<i64>>,
    genres: Option<Vec<String>>,
    metadata_locked: Option<bool>,
}

#[tauri::command(async)]
pub fn update_series(state: State<AppState>, id: String, patch: SeriesPatch) -> Cmd<()> {
    let conn = state.db()?;
    let ts = now();
    if let Some(t) = patch.title.as_ref().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        let old: String = conn.query_row("SELECT title FROM series WHERE id = ?1", params![id], |r| r.get(0))?;
        db::add_alias(&conn, &old, &id)?;
        db::add_alias(&conn, &t, &id)?;
        conn.execute("UPDATE series SET title = ?1, updated_at = ?2 WHERE id = ?3", params![t, ts, id])?;
    }
    if let Some(a) = patch.alt_title {
        let a = a.map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        if let Some(alias) = &a {
            db::add_alias(&conn, alias, &id)?;
        }
        conn.execute("UPDATE series SET alt_title = ?1, updated_at = ?2 WHERE id = ?3", params![a, ts, id])?;
    }
    if let Some(d) = patch.description {
        conn.execute("UPDATE series SET description = ?1, updated_at = ?2 WHERE id = ?3", params![d, ts, id])?;
    }
    if let Some(y) = patch.year {
        conn.execute("UPDATE series SET year = ?1, updated_at = ?2 WHERE id = ?3", params![y, ts, id])?;
    }
    if let Some(g) = patch.genres {
        conn.execute("UPDATE series SET genres = ?1, updated_at = ?2 WHERE id = ?3", params![serde_json::to_string(&g)?, ts, id])?;
    }
    if let Some(l) = patch.metadata_locked {
        conn.execute("UPDATE series SET metadata_locked = ?1, updated_at = ?2 WHERE id = ?3", params![l as i64, ts, id])?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn create_series(state: State<AppState>, title: String) -> Cmd<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::msg("Bitte einen Seriennamen eingeben."));
    }
    let conn = state.db()?;
    if let Some(id) = db::find_series_by_alias(&conn, title)? {
        return Ok(id);
    }
    let id = db::create_series(&conn, title, None, None)?;
    // Manuell angelegt: nicht automatisch aufräumen
    conn.execute("UPDATE series SET user_created = 1 WHERE id = ?1", params![id])?;
    Ok(id)
}

/// Entfernt eine Serie aus der Bibliothek. Dateien bleiben IMMER unangetastet.
/// mode = "unsort": Episoden landen bei den unsortierten Dateien, "hide": Episoden werden ausgeblendet.
#[tauri::command(async)]
pub fn remove_series(state: State<AppState>, id: String, mode: String) -> Cmd<()> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    if mode == "hide" {
        tx.execute("UPDATE episodes SET ignored = 1, series_id = NULL, manual = 1, updated_at = ?1 WHERE series_id = ?2", params![now(), id])?;
    } else {
        tx.execute("UPDATE episodes SET series_id = NULL, manual = 1, updated_at = ?1 WHERE series_id = ?2", params![now(), id])?;
    }
    tx.execute("DELETE FROM series WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn merge_series(state: State<AppState>, source_id: String, target_id: String) -> Cmd<()> {
    if source_id == target_id {
        return Ok(());
    }
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    let title: String = tx.query_row("SELECT title FROM series WHERE id = ?1", params![source_id], |r| r.get(0))?;
    tx.execute("UPDATE episodes SET series_id = ?1, updated_at = ?2 WHERE series_id = ?3", params![target_id, now(), source_id])?;
    tx.execute("UPDATE series_aliases SET series_id = ?1 WHERE series_id = ?2", params![target_id, source_id])?;
    tx.execute("UPDATE assignment_rules SET series_id = ?1 WHERE series_id = ?2", params![target_id, source_id])?;
    db::add_alias(&tx, &title, &target_id)?;
    tx.execute("UPDATE series SET favorite = MAX(favorite, (SELECT favorite FROM series WHERE id = ?2)) WHERE id = ?1", params![target_id, source_id])?;
    tx.execute("DELETE FROM series WHERE id = ?1", params![source_id])?;
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn set_series_image(state: State<AppState>, id: String, kind: String, path: String) -> Cmd<String> {
    let src = PathBuf::from(&path);
    system::ensure_exists(&src)?;
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "jpg".into());
    if !["jpg", "jpeg", "png", "webp", "gif", "avif"].contains(&ext.as_str()) {
        return Err(AppError::msg("Bitte eine Bilddatei (JPG, PNG, WEBP) auswählen."));
    }
    let col = if kind == "banner" { "banner" } else { "cover" };
    std::fs::create_dir_all(state.images_dir())?;
    let name = format!("{id}_{col}_custom_{}.{ext}", chrono::Utc::now().timestamp());
    std::fs::copy(&src, state.images_dir().join(&name))?;
    let rel = format!("images/{name}");
    let conn = state.db()?;
    let old: Option<String> = conn.query_row(&format!("SELECT {col}_path FROM series WHERE id = ?1"), params![id], |r| r.get(0))?;
    conn.execute(&format!("UPDATE series SET {col}_path = ?1, custom_{col} = 1, updated_at = ?2 WHERE id = ?3"), params![rel, now(), id])?;
    if let Some(o) = old {
        let _ = std::fs::remove_file(db::data_file(&state.data_dir, &o));
    }
    Ok(rel)
}

#[tauri::command(async)]
pub fn reset_series_image(state: State<AppState>, id: String, kind: String) -> Cmd<()> {
    let col = if kind == "banner" { "banner" } else { "cover" };
    let conn = state.db()?;
    let old: Option<String> = conn.query_row(&format!("SELECT {col}_path FROM series WHERE id = ?1"), params![id], |r| r.get(0))?;
    if let Some(o) = old {
        let _ = std::fs::remove_file(db::data_file(&state.data_dir, &o));
    }
    conn.execute(&format!("UPDATE series SET {col}_path = NULL, custom_{col} = 0, updated_at = ?1 WHERE id = ?2"), params![now(), id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn reorder_series(state: State<AppState>, ids: Vec<String>) -> Cmd<()> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE series SET sort_index = ?1 WHERE id = ?2", params![i as i64, id])?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn set_season_name(state: State<AppState>, series_id: String, season: i64, title: Option<String>) -> Cmd<()> {
    let conn = state.db()?;
    match title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(t) => conn.execute(
            "INSERT INTO season_names(series_id, season, title) VALUES(?1, ?2, ?3) ON CONFLICT(series_id, season) DO UPDATE SET title = excluded.title",
            params![series_id, season, t],
        )?,
        None => conn.execute("DELETE FROM season_names WHERE series_id = ?1 AND season = ?2", params![series_id, season])?,
    };
    Ok(())
}

// ---------------------------------------------------------------------------
// Episoden zuordnen und bearbeiten (verändert nur die Datenbank)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignRequest {
    episode_ids: Vec<String>,
    series_id: Option<String>,
    new_series_title: Option<String>,
    season: Option<i64>,
    start_episode: Option<i64>,
    kind: Option<String>,
    remember_folders: bool,
}

#[tauri::command(async)]
pub fn assign_episodes(state: State<AppState>, req: AssignRequest) -> Cmd<String> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    let series_id = match (&req.series_id, &req.new_series_title) {
        (Some(id), _) => id.clone(),
        (None, Some(t)) if !t.trim().is_empty() => match db::find_series_by_alias(&tx, t.trim())? {
            Some(id) => id,
            None => {
                let id = db::create_series(&tx, t.trim(), None, None)?;
                tx.execute("UPDATE series SET user_created = 1 WHERE id = ?1", params![id])?;
                id
            }
        },
        _ => return Err(AppError::msg("Bitte eine Serie auswählen oder einen neuen Namen eingeben.")),
    };
    let ts = now();
    let mut folders: Vec<String> = vec![];
    for (i, id) in req.episode_ids.iter().enumerate() {
        let path: String = tx.query_row("SELECT file_path FROM episodes WHERE id = ?1", params![id], |r| r.get(0))?;
        if let Some(dir) = Path::new(&path).parent() {
            let d = dir.to_string_lossy().to_string();
            if !folders.contains(&d) {
                folders.push(d);
            }
        }
        tx.execute(
            "UPDATE episodes SET series_id = ?1, manual = 1, ignored = 0, confidence = 1.0, updated_at = ?2,
                    season = CASE WHEN ?3 IS NULL THEN season ELSE ?3 END,
                    episode = CASE WHEN ?4 IS NULL THEN episode ELSE ?4 END,
                    kind = COALESCE(?5, kind)
             WHERE id = ?6",
            params![series_id, ts, req.season, req.start_episode.map(|s| s + i as i64), req.kind, id],
        )?;
    }
    if req.remember_folders {
        for f in folders {
            // Niemals einen ganzen Quellordner (z. B. D:Anime) an eine Serie binden
            let is_source: i64 = tx.query_row("SELECT COUNT(*) FROM sources WHERE path = ?1", params![f], |r| r.get(0))?;
            if is_source > 0 {
                continue;
            }
            // Nur Ordner merken, deren Dateien alle zu dieser Serie gehören
            let other: i64 = tx.query_row(
                "SELECT COUNT(*) FROM episodes WHERE file_path LIKE ?1 || '\\%' AND series_id IS NOT NULL AND series_id <> ?2",
                params![f, series_id],
                |r| r.get(0),
            )?;
            if other == 0 {
                tx.execute(
                    "INSERT INTO assignment_rules(folder_path, series_id, season, created_at) VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(folder_path) DO UPDATE SET series_id = excluded.series_id, season = excluded.season",
                    params![f, series_id, req.season, ts],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(series_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodePatch {
    season: Option<Option<i64>>,
    episode: Option<Option<i64>>,
    episode_end: Option<Option<i64>>,
    title: Option<Option<String>>,
    kind: Option<String>,
    version: Option<Option<i64>>,
}

#[tauri::command(async)]
pub fn update_episode(state: State<AppState>, id: String, patch: EpisodePatch) -> Cmd<()> {
    let conn = state.db()?;
    let ts = now();
    if let Some(v) = patch.season {
        conn.execute("UPDATE episodes SET season = ?1, sort_index = NULL WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = patch.episode {
        conn.execute("UPDATE episodes SET episode = ?1, sort_index = NULL WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = patch.episode_end {
        conn.execute("UPDATE episodes SET episode_end = ?1 WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = patch.title {
        conn.execute("UPDATE episodes SET title = ?1 WHERE id = ?2", params![v.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()), id])?;
    }
    if let Some(v) = patch.kind {
        conn.execute("UPDATE episodes SET kind = ?1 WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = patch.version {
        conn.execute("UPDATE episodes SET version = ?1 WHERE id = ?2", params![v, id])?;
    }
    conn.execute("UPDATE episodes SET manual = 1, updated_at = ?1 WHERE id = ?2", params![ts, id])?;
    Ok(())
}

/// Drag-and-drop auf eine andere Staffel (bzw. Specials = Art "special").
#[tauri::command(async)]
pub fn move_episodes_to_season(state: State<AppState>, ids: Vec<String>, season: Option<i64>, kind: String) -> Cmd<()> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE episodes SET season = ?1, kind = ?2, sort_index = NULL, manual = 1, updated_at = ?3 WHERE id = ?4",
            params![season, kind, now(), id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Manuelle Reihenfolge innerhalb einer Staffel.
#[tauri::command(async)]
pub fn reorder_episodes(state: State<AppState>, ids: Vec<String>) -> Cmd<()> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE episodes SET sort_index = ?1, manual = 1 WHERE id = ?2", params![(i as i64 + 1) * 100, id])?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn unassign_episodes(state: State<AppState>, ids: Vec<String>) -> Cmd<()> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("UPDATE episodes SET series_id = NULL, manual = 1, updated_at = ?1 WHERE id = ?2", params![now(), id])?;
    }
    tx.commit()?;
    Ok(())
}

/// Aus der Bibliothek entfernen (ausblenden). Die Datei bleibt erhalten und wird bei Scans übersprungen.
#[tauri::command(async)]
pub fn hide_episodes(state: State<AppState>, ids: Vec<String>) -> Cmd<()> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("UPDATE episodes SET ignored = 1, updated_at = ?1 WHERE id = ?2", params![now(), id])?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn restore_episodes(state: State<AppState>, ids: Vec<String>) -> Cmd<()> {
    system::record_ignored_restore(&*state.db()?, &ids)
}

/// Löscht Datenbankeinträge fehlender Dateien. Betrifft nur die Datenbank.
#[tauri::command(async)]
pub fn forget_episodes(state: State<AppState>, ids: Vec<String>) -> Cmd<usize> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    let mut n = 0;
    for id in ids {
        n += tx.execute("DELETE FROM episodes WHERE id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(n)
}

/// Verschiebt die echte Videodatei in den Papierkorb. Nur nach ausdrücklicher Bestätigung in der Oberfläche.
#[tauri::command(async)]
pub fn delete_episode_file(state: State<AppState>, id: String, confirm_file_name: String) -> Cmd<()> {
    let conn = state.db()?;
    let (path, name): (String, String) = conn.query_row("SELECT file_path, file_name FROM episodes WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if confirm_file_name != name {
        return Err(AppError::msg("Bestätigung stimmt nicht mit dem Dateinamen überein."));
    }
    system::ensure_exists(Path::new(&path))?;
    trash::delete(&path)?;
    conn.execute("DELETE FROM episodes WHERE id = ?1", params![id])?;
    conn.execute(
        "INSERT INTO file_operations(executed_at, episode_id, op, from_path, to_path, status) VALUES(?1, ?2, 'trash', ?3, 'Papierkorb', 'ok')",
        params![now(), id, path],
    )?;
    log::info!("Datei in den Papierkorb verschoben: {path}");
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    reason: String,
    episodes: Vec<Episode>,
}

#[tauri::command(async)]
pub fn find_duplicates(state: State<AppState>) -> Cmd<Vec<DuplicateGroup>> {
    let conn = state.db()?;
    let all = db::episodes_where(&conn, "e.ignored = 0", db::EPISODE_ORDER, &[])?;
    let mut by_slot: HashMap<(String, i64, i64, String), Vec<Episode>> = HashMap::new();
    let mut by_file: HashMap<(String, i64), Vec<Episode>> = HashMap::new();
    for e in all {
        by_file.entry((e.file_name.to_lowercase(), e.file_size)).or_default().push(e.clone());
        if let (Some(s), Some(ep)) = (&e.series_id, e.episode) {
            by_slot.entry((s.clone(), e.season.unwrap_or(1), ep, e.kind.clone())).or_default().push(e);
        }
    }
    let mut out = vec![];
    for (_, v) in by_file.into_iter().filter(|(_, v)| v.len() > 1) {
        out.push(DuplicateGroup { reason: "sameFile".into(), episodes: v });
    }
    for (_, v) in by_slot.into_iter().filter(|(_, v)| v.len() > 1) {
        if !out.iter().any(|g| g.episodes.iter().all(|x| v.iter().any(|y| y.id == x.id)) && g.episodes.len() == v.len()) {
            out.push(DuplicateGroup { reason: "sameEpisode".into(), episodes: v });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Wiedergabe
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackInfo {
    episode: Episode,
    series: Option<SeriesSummary>,
    previous_id: Option<String>,
    next_id: Option<String>,
    next: Option<Episode>,
    subtitles: Vec<SubtitleTrack>,
}

#[tauri::command(async)]
pub fn get_playback(app: AppHandle, state: State<AppState>, id: String) -> Cmd<PlaybackInfo> {
    let (episode, series, prev, next) = {
        let conn = state.db()?;
        let episode = db::get_episode(&conn, &id)?.ok_or_else(|| AppError::msg("Episode nicht gefunden"))?;
        let series = match &episode.series_id {
            Some(s) => db::get_series(&conn, s)?,
            None => None,
        };
        let (mut prev, mut next) = (None, None);
        if let Some(sid) = &episode.series_id {
            let eps: Vec<Episode> = db::series_episodes(&conn, sid)?.into_iter().filter(|e| e.available && !e.missing).collect();
            if let Some(i) = eps.iter().position(|e| e.id == id) {
                prev = i.checked_sub(1).and_then(|j| eps.get(j)).map(|e| e.id.clone());
                // Nächste Folge: gleiche Art, andere Episodennummer (Versionen überspringen)
                next = eps.iter().skip(i + 1).find(|e| !(e.season == episode.season && e.episode == episode.episode && e.kind == episode.kind)).cloned();
            }
        }
        (episode, series, prev, next)
    };
    system::ensure_exists(Path::new(&episode.file_path))?;
    let subtitles = subtitles::list_tracks(&app, &id).unwrap_or_default();
    Ok(PlaybackInfo { next_id: next.as_ref().map(|e| e.id.clone()), next, episode, series, previous_id: prev, subtitles })
}

#[tauri::command(async)]
pub fn save_progress(state: State<AppState>, id: String, position: f64, duration: Option<f64>, finished: bool) -> Cmd<bool> {
    let conn = state.db()?;
    let settings = settings::load(&conn)?;
    let ts = now();
    let mut watched = finished;
    if let Some(d) = duration.filter(|d| *d > 0.0) {
        if position / d * 100.0 >= settings.mark_watched_percent as f64 {
            watched = true;
        }
        conn.execute("UPDATE episodes SET duration = ?1 WHERE id = ?2", params![d, id])?;
    }
    if watched {
        conn.execute(
            "UPDATE episodes SET watched = 1, watched_at = COALESCE(watched_at, ?1), position = 0, last_played_at = ?1, play_count = play_count + CASE WHEN watched = 0 THEN 1 ELSE 0 END WHERE id = ?2",
            params![ts, id],
        )?;
    } else {
        conn.execute("UPDATE episodes SET position = ?1, last_played_at = ?2 WHERE id = ?3", params![position, ts, id])?;
    }
    Ok(watched)
}

#[tauri::command(async)]
pub fn mark_watched(state: State<AppState>, ids: Vec<String>, watched: bool) -> Cmd<()> {
    let mut conn = state.db()?;
    let tx = conn.transaction()?;
    let ts = now();
    for id in ids {
        if watched {
            tx.execute("UPDATE episodes SET watched = 1, watched_at = ?1, position = 0 WHERE id = ?2", params![ts, id])?;
        } else {
            tx.execute("UPDATE episodes SET watched = 0, watched_at = NULL, position = 0 WHERE id = ?1", params![id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn mark_series_watched(state: State<AppState>, series_id: String, watched: bool) -> Cmd<()> {
    let conn = state.db()?;
    if watched {
        conn.execute("UPDATE episodes SET watched = 1, watched_at = COALESCE(watched_at, ?1), position = 0 WHERE series_id = ?2", params![now(), series_id])?;
    } else {
        conn.execute("UPDATE episodes SET watched = 0, watched_at = NULL, position = 0, last_played_at = NULL WHERE series_id = ?1", params![series_id])?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn save_thumbnail(state: State<AppState>, id: String, data: String, duration: Option<f64>) -> Cmd<String> {
    use base64_lite::decode;
    let raw = data.split(',').nth(1).unwrap_or(&data);
    let bytes = decode(raw).ok_or_else(|| AppError::msg("Ungültiges Vorschaubild"))?;
    std::fs::create_dir_all(state.thumbs_dir())?;
    let name = format!("{id}.jpg");
    std::fs::write(state.thumbs_dir().join(&name), bytes)?;
    let rel = format!("thumbs/{name}");
    let conn = state.db()?;
    conn.execute("UPDATE episodes SET thumbnail_path = ?1, duration = COALESCE(?2, duration) WHERE id = ?3", params![rel, duration, id])?;
    Ok(rel)
}

#[tauri::command(async)]
pub fn get_subtitle(app: AppHandle, episode_id: String, track: String) -> Cmd<String> {
    // MKV-Extraktion liest die ganze Datei – das darf die Oberfläche nicht blockieren (async-Kontext von Tauri)
    subtitles::vtt_for(&app, &episode_id, &track)
}

#[tauri::command(async)]
pub fn load_subtitle_file(path: String) -> Cmd<String> {
    subtitles::file_to_vtt(Path::new(&path))
}

// ---------------------------------------------------------------------------
// Windows-Aktionen
// ---------------------------------------------------------------------------

fn episode_path(state: &AppState, id: &str) -> AppResult<PathBuf> {
    let conn = state.db()?;
    let p: String = conn.query_row("SELECT file_path FROM episodes WHERE id = ?1", params![id], |r| r.get(0)).map_err(|_| AppError::msg("Episode nicht gefunden"))?;
    Ok(PathBuf::from(p))
}

#[tauri::command(async)]
pub fn open_in_default_player(state: State<AppState>, id: String) -> Cmd<()> {
    let p = episode_path(&state, &id)?;
    system::open_default(&p)?;
    state.db()?.execute("UPDATE episodes SET last_played_at = ?1 WHERE id = ?2", params![now(), id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn reveal_in_explorer(state: State<AppState>, id: String) -> Cmd<()> {
    system::reveal(&episode_path(&state, &id)?)
}

#[tauri::command(async)]
pub fn open_episode_folder(state: State<AppState>, id: String) -> Cmd<()> {
    system::open_folder(&episode_path(&state, &id)?)
}

#[tauri::command(async)]
pub fn open_series_folder(state: State<AppState>, id: String) -> Cmd<()> {
    let conn = state.db()?;
    let eps = db::series_episodes(&conn, &id)?;
    drop(conn);
    let folders = series_folders(&eps);
    let Some(f) = folders.iter().find(|f| Path::new(f).exists()).or(folders.first()) else {
        return Err(AppError::msg("Zu dieser Serie wurden keine Dateien gefunden."));
    };
    system::open_folder(Path::new(f))
}

#[tauri::command(async)]
pub fn open_path(path: String) -> Cmd<()> {
    system::open_folder(Path::new(&path))
}

#[tauri::command(async)]
pub fn file_properties(state: State<AppState>, id: String) -> Cmd<system::FileProperties> {
    let conn = state.db()?;
    let (p, origin): (String, Option<String>) = conn.query_row("SELECT file_path, origin_path FROM episodes WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    drop(conn);
    Ok(system::properties(Path::new(&p), origin))
}

// ---------------------------------------------------------------------------
// Quellordner & Scan
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn add_source(app: AppHandle, state: State<AppState>, path: String, scan: bool) -> Cmd<Source> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(AppError::msg("Der Ordner existiert nicht oder ist nicht erreichbar."));
    }
    let path = p.to_string_lossy().trim_end_matches('\\').to_string();
    let path = if path.ends_with(':') { format!("{path}\\") } else { path };
    let id = {
        let conn = state.db()?;
        let existing: Option<String> = conn.query_row("SELECT id FROM sources WHERE path = ?1", params![path], |r| r.get(0)).optional()?;
        match existing {
            Some(id) => {
                conn.execute("UPDATE sources SET enabled = 1 WHERE id = ?1", params![id])?;
                id
            }
            None => {
                let id = db::new_id();
                conn.execute("INSERT INTO sources(id, path, kind, added_at) VALUES(?1, ?2, 'source', ?3)", params![id, path, now()])?;
                id
            }
        }
    };
    crate::watcher::configure(&app);
    if scan {
        let _ = scanner::start_scan(&app, Some(vec![id.clone()]), "manual");
    }
    let conn = state.db()?;
    db::list_sources(&conn)?.into_iter().find(|s| s.id == id).ok_or_else(|| AppError::msg("Quellordner konnte nicht angelegt werden"))
}

/// Entfernt einen Quellordner. Mit `remove_entries` werden auch die Datenbankeinträge gelöscht – Dateien nie.
#[tauri::command(async)]
pub fn remove_source(app: AppHandle, state: State<AppState>, id: String, remove_entries: bool) -> Cmd<()> {
    {
        let mut conn = state.db()?;
        let tx = conn.transaction()?;
        if remove_entries {
            tx.execute("DELETE FROM episodes WHERE source_id = ?1", params![id])?;
        } else {
            tx.execute("UPDATE episodes SET source_id = NULL WHERE source_id = ?1", params![id])?;
        }
        tx.execute("DELETE FROM sources WHERE id = ?1", params![id])?;
        tx.commit()?;
    }
    crate::watcher::configure(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn set_source_enabled(app: AppHandle, state: State<AppState>, id: String, enabled: bool) -> Cmd<()> {
    state.db()?.execute("UPDATE sources SET enabled = ?1 WHERE id = ?2", params![enabled as i64, id])?;
    crate::watcher::configure(&app);
    Ok(())
}

// ---------------------------------------------------------------------------
// Links zu offiziellen Streaming-Anbietern (öffnen im Browser, kein Auslesen/Download)
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn add_series_link(state: State<AppState>, series_id: String, url: String) -> Cmd<()> {
    let conn = state.db()?;
    crate::links::add(&conn, &series_id, &url, "user")
}

#[tauri::command(async)]
pub fn remove_series_link(state: State<AppState>, id: String) -> Cmd<()> {
    state.db()?.execute("DELETE FROM series_links WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn open_link(url: String) -> Cmd<()> {
    let (url, _) = crate::links::validate(&url)?;
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| AppError::msg(format!("Link konnte nicht geöffnet werden: {e}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    url: String,
    provider: String,
    provider_name: String,
    title: Option<String>,
}

/// Prüft einen eingefügten Link und schlägt einen Seriennamen vor.
#[tauri::command(async)]
pub fn inspect_link(url: String) -> Cmd<LinkInfo> {
    let (url, provider) = crate::links::validate(&url)?;
    Ok(LinkInfo { title: crate::links::title_from_url(&url), provider_name: crate::links::display_name(&url, provider), provider: provider.to_string(), url })
}

/// Legt eine Online-Serie an (oder nutzt eine bestehende gleichen Namens) und speichert den Link.
#[tauri::command(async)]
pub fn create_series_from_link(app: AppHandle, state: State<AppState>, url: String, title: String) -> Cmd<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::msg("Bitte einen Seriennamen eingeben."));
    }
    let id = {
        let conn = state.db()?;
        let id = match db::find_series_by_alias(&conn, title)? {
            Some(id) => id,
            None => {
                let id = db::create_series(&conn, title, None, None)?;
                conn.execute("UPDATE series SET user_created = 1 WHERE id = ?1", params![id])?;
                id
            }
        };
        crate::links::add(&conn, &id, &url, "user")?;
        id
    };
    if state.settings()?.auto_metadata {
        metadata::start_auto_fetch(&app);
    }
    Ok(id)
}

#[tauri::command(async)]
pub fn list_sources(state: State<AppState>) -> Cmd<Vec<Source>> {
    db::list_sources(&*state.db()?)
}

#[tauri::command(async)]
pub fn start_scan(app: AppHandle, source_ids: Option<Vec<String>>) -> Cmd<()> {
    scanner::start_scan(&app, source_ids, "manual")
}

#[tauri::command(async)]
pub fn cancel_scan(state: State<AppState>) -> Cmd<()> {
    state.scan_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command(async)]
pub fn scan_status(state: State<AppState>) -> Cmd<Option<ScanProgress>> {
    Ok(state.last_scan_progress.lock().ok().and_then(|g| g.clone()))
}

#[tauri::command(async)]
pub fn add_files(app: AppHandle, paths: Vec<String>, series_id: Option<String>) -> Cmd<Value> {
    let (added, skipped) = scanner::add_files(&app, paths, series_id.as_deref())?;
    crate::watcher::configure(&app);
    Ok(json!({ "added": added, "skipped": skipped }))
}

// ---------------------------------------------------------------------------
// Metadaten
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn metadata_search(app: AppHandle, query: String) -> Cmd<Vec<AnimeMatch>> {
    metadata::search(&app, &query).await
}

#[tauri::command(async)]
pub async fn metadata_apply(app: AppHandle, series_id: String, item: AnimeMatch, rename: bool) -> Cmd<()> {
    metadata::apply_match(&app, &series_id, &item, rename).await?;
    let state = app.state::<AppState>();
    state.db()?.execute("UPDATE series SET metadata_locked = 1 WHERE id = ?1", params![series_id])?;
    Ok(())
}

#[tauri::command]
pub async fn discover_episodes(app: AppHandle, anilist_id: i64) -> Cmd<metadata::DiscoverDetail> {
    metadata::discover_episodes(&app, anilist_id).await
}

#[tauri::command]
pub async fn discover_add(app: AppHandle, item: AnimeMatch) -> Cmd<String> {
    metadata::discover_add(&app, &item).await
}

#[tauri::command(async)]
pub fn metadata_refresh(app: AppHandle, state: State<AppState>, series_ids: Option<Vec<String>>, include_matched: bool) -> Cmd<()> {
    {
        let conn = state.db()?;
        match series_ids {
            Some(ids) => {
                for id in ids {
                    conn.execute("UPDATE series SET metadata_status = 'pending', metadata_locked = 0 WHERE id = ?1", params![id])?;
                }
            }
            None => {
                if include_matched {
                    conn.execute("UPDATE series SET metadata_status = 'pending' WHERE metadata_locked = 0", [])?;
                } else {
                    conn.execute("UPDATE series SET metadata_status = 'pending' WHERE metadata_locked = 0 AND metadata_status <> 'matched'", [])?;
                }
            }
        }
    }
    metadata::start_auto_fetch(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn metadata_clear(state: State<AppState>, series_id: String) -> Cmd<()> {
    let conn = state.db()?;
    for col in ["cover", "banner"] {
        let (old, custom): (Option<String>, i64) = conn.query_row(&format!("SELECT {col}_path, custom_{col} FROM series WHERE id = ?1"), params![series_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        if custom == 0 {
            if let Some(o) = old {
                let _ = std::fs::remove_file(db::data_file(&state.data_dir, &o));
            }
            conn.execute(&format!("UPDATE series SET {col}_path = NULL WHERE id = ?1"), params![series_id])?;
        }
    }
    conn.execute(
        "UPDATE series SET anilist_id = NULL, description = NULL, genres = '[]', score = NULL, format = NULL, studio = NULL, total_episodes = NULL, metadata_status = 'notfound', metadata_locked = 1, updated_at = ?1 WHERE id = ?2",
        params![now(), series_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn get_settings(state: State<AppState>) -> Cmd<Settings> {
    state.settings()
}

#[tauri::command(async)]
pub fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Cmd<Settings> {
    let old = state.settings()?;
    {
        let conn = state.db()?;
        settings::save(&conn, &settings)?;
        if let Some(lib) = settings.library_path.as_ref().filter(|p| !p.trim().is_empty()) {
            std::fs::create_dir_all(lib).map_err(|_| AppError::msg("Bibliotheksordner konnte nicht angelegt werden."))?;
            fileops::ensure_library_source(&conn, lib)?;
        }
        if old.library_path != settings.library_path {
            if let Some(o) = &old.library_path {
                conn.execute("UPDATE sources SET kind = 'source' WHERE path = ?1", params![o])?;
            }
        }
    }
    if old.watch_folders != settings.watch_folders || old.library_path != settings.library_path {
        crate::watcher::configure(&app);
    }
    if old.title_language != settings.title_language || old.cover_quality != settings.cover_quality {
        log::info!("Metadaten-Einstellungen geändert – Aktualisierung über 'Metadaten aktualisieren' möglich");
    }
    Ok(settings)
}

#[tauri::command(async)]
pub fn reset_settings(state: State<AppState>) -> Cmd<Settings> {
    let s = Settings::default();
    settings::save(&*state.db()?, &s)?;
    Ok(s)
}

// ---------------------------------------------------------------------------
// Dateioperationen
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn plan_file_operation(app: AppHandle, req: PlanRequest) -> Cmd<Plan> {
    fileops::plan(&app, req)
}

#[tauri::command(async)]
pub fn execute_file_operation(app: AppHandle, mode: String, ops: Vec<PlannedOp>) -> Cmd<()> {
    fileops::execute(&app, mode, ops)
}

#[tauri::command(async)]
pub fn count_outside_library(state: State<AppState>) -> Cmd<i64> {
    let settings = state.settings()?;
    let Some(lib) = settings.library_path.filter(|p| !p.is_empty()) else { return Ok(0) };
    let conn = state.db()?;
    let pattern = format!("{}\\%", lib.trim_end_matches('\\'));
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM episodes WHERE series_id IS NOT NULL AND ignored = 0 AND available = 1 AND missing = 0 AND file_path NOT LIKE ?1",
        params![pattern],
        |r| r.get(0),
    )?)
}

// ---------------------------------------------------------------------------
// Daten & Datenschutz
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn create_backup(state: State<AppState>, path: Option<String>) -> Cmd<String> {
    system::backup_to(&state, path.map(PathBuf::from))
}

#[tauri::command(async)]
pub fn restore_backup(state: State<AppState>, path: String) -> Cmd<()> {
    system::restore_backup(&state, Path::new(&path))
}

#[tauri::command(async)]
pub fn list_backups(state: State<AppState>) -> Cmd<Vec<Value>> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(state.backups_dir()) {
        for e in rd.flatten() {
            let m = e.metadata().ok();
            out.push(json!({
                "path": e.path(),
                "name": e.file_name().to_string_lossy(),
                "size": m.as_ref().map(|m| m.len()),
            }));
        }
    }
    out.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    Ok(out)
}

#[tauri::command(async)]
pub fn export_library(state: State<AppState>, path: String) -> Cmd<()> {
    system::export_library(&state, Path::new(&path))
}

#[tauri::command(async)]
pub fn import_library(state: State<AppState>, path: String) -> Cmd<usize> {
    system::import_library(&state, Path::new(&path))
}

#[tauri::command(async)]
pub fn clear_cache(state: State<AppState>, kind: String) -> Cmd<()> {
    system::clear_cache(&state, &kind)
}

#[tauri::command(async)]
pub fn read_logs(state: State<AppState>) -> Cmd<String> {
    system::read_logs(&state)
}

#[tauri::command(async)]
pub fn diagnostics(app: AppHandle) -> Cmd<Value> {
    system::diagnostics(&app)
}

#[tauri::command(async)]
pub fn move_database(app: AppHandle, dir: String) -> Cmd<String> {
    system::move_database(&app, Path::new(&dir))
}

#[tauri::command(async)]
pub fn reset_database_location(app: AppHandle) -> Cmd<()> {
    let config = app.path().app_config_dir()?;
    let _ = std::fs::remove_file(config.join("database_location.txt"));
    Ok(())
}

#[tauri::command(async)]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command(async)]
pub fn log_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[UI] {message}"),
        "warn" => log::warn!("[UI] {message}"),
        _ => log::info!("[UI] {message}"),
    }
}

/// Minimaler Base64-Decoder (für Vorschaubilder aus dem Canvas), um keine zusätzliche Abhängigkeit zu benötigen.
mod base64_lite {
    pub fn decode(s: &str) -> Option<Vec<u8>> {
        fn val(c: u8) -> Option<u32> {
            match c {
                b'A'..=b'Z' => Some((c - b'A') as u32),
                b'a'..=b'z' => Some((c - b'a' + 26) as u32),
                b'0'..=b'9' => Some((c - b'0' + 52) as u32),
                b'+' | b'-' => Some(62),
                b'/' | b'_' => Some(63),
                _ => None,
            }
        }
        let bytes: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
        let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
        for chunk in bytes.chunks(4) {
            let mut n = 0u32;
            for (i, &c) in chunk.iter().enumerate() {
                n |= val(c)? << (18 - 6 * i);
            }
            out.push((n >> 16) as u8);
            if chunk.len() > 2 {
                out.push((n >> 8 & 0xFF) as u8);
            }
            if chunk.len() > 3 {
                out.push((n & 0xFF) as u8);
            }
        }
        Some(out)
    }
}
