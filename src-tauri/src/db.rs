//! SQLite-Datenbank: Schema, Migrationen und Lesezugriffe für die Oberfläche.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::AppResult;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL DEFAULT 'source',
  enabled INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,
  added_at TEXT,
  last_scan_at TEXT
);

CREATE TABLE IF NOT EXISTS series(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  alt_title TEXT,
  description TEXT,
  year INTEGER,
  genres TEXT NOT NULL DEFAULT '[]',
  cover_path TEXT,
  banner_path TEXT,
  custom_cover INTEGER NOT NULL DEFAULT 0,
  custom_banner INTEGER NOT NULL DEFAULT 0,
  anilist_id INTEGER,
  metadata_status TEXT NOT NULL DEFAULT 'pending',
  metadata_locked INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  user_created INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER,
  score INTEGER,
  format TEXT,
  total_episodes INTEGER,
  studio TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS series_aliases(
  alias_norm TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS episodes(
  id TEXT PRIMARY KEY,
  series_id TEXT REFERENCES series(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  origin_path TEXT COLLATE NOCASE,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_mtime INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  season INTEGER,
  episode INTEGER,
  episode_end INTEGER,
  kind TEXT NOT NULL DEFAULT 'episode',
  title TEXT,
  resolution TEXT,
  audio_hints TEXT NOT NULL DEFAULT '[]',
  subtitle_hints TEXT NOT NULL DEFAULT '[]',
  version INTEGER,
  parsed_series TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  missing INTEGER NOT NULL DEFAULT 0,
  missing_since TEXT,
  ignored INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  position REAL NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  watched_at TEXT,
  last_played_at TEXT,
  play_count INTEGER NOT NULL DEFAULT 0,
  thumbnail_path TEXT,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id);
CREATE INDEX IF NOT EXISTS idx_episodes_played ON episodes(last_played_at);
CREATE INDEX IF NOT EXISTS idx_episodes_added ON episodes(added_at);
CREATE INDEX IF NOT EXISTS idx_episodes_name_size ON episodes(file_name, file_size);
CREATE INDEX IF NOT EXISTS idx_episodes_origin ON episodes(origin_path);

CREATE TABLE IF NOT EXISTS assignment_rules(
  folder_path TEXT PRIMARY KEY COLLATE NOCASE,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS season_names(
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY(series_id, season)
);

CREATE TABLE IF NOT EXISTS scan_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger TEXT,
  files_found INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  moved INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  unsorted INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS metadata_cache(
  query TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_operations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  executed_at TEXT NOT NULL,
  episode_id TEXT,
  op TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
"#;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn open(path: &Path) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    let version: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0))
        .optional()?;
    if version.is_none() {
        conn.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?1)", params![SCHEMA_VERSION.to_string()])?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// DTOs für die Oberfläche
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub enabled: bool,
    pub available: bool,
    pub added_at: Option<String>,
    pub last_scan_at: Option<String>,
    pub episode_count: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSummary {
    pub id: String,
    pub title: String,
    pub alt_title: Option<String>,
    pub description: Option<String>,
    pub year: Option<i64>,
    pub genres: Vec<String>,
    pub cover_path: Option<String>,
    pub banner_path: Option<String>,
    pub favorite: bool,
    pub sort_index: Option<i64>,
    pub anilist_id: Option<i64>,
    pub metadata_status: String,
    pub metadata_locked: bool,
    pub format: Option<String>,
    pub score: Option<i64>,
    pub studio: Option<String>,
    pub total_episodes: Option<i64>,
    pub episode_count: i64,
    pub available_count: i64,
    pub unavailable_count: i64,
    pub watched_count: i64,
    pub in_progress_count: i64,
    pub season_count: i64,
    pub last_played_at: Option<String>,
    pub last_added_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Erster Streaming-Anbieter (z. B. "crunchyroll"), falls Links hinterlegt sind
    pub online_provider: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub series_id: Option<String>,
    pub series_title: Option<String>,
    pub file_path: String,
    pub origin_path: Option<String>,
    pub file_name: String,
    pub file_size: i64,
    pub file_mtime: i64,
    pub source_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_end: Option<i64>,
    pub kind: String,
    pub title: Option<String>,
    pub resolution: Option<String>,
    pub audio_hints: Vec<String>,
    pub subtitle_hints: Vec<String>,
    pub version: Option<i64>,
    pub parsed_series: Option<String>,
    pub confidence: f64,
    pub manual: bool,
    pub sort_index: Option<i64>,
    pub available: bool,
    pub missing: bool,
    pub missing_since: Option<String>,
    pub ignored: bool,
    pub duration: Option<f64>,
    pub position: f64,
    pub watched: bool,
    pub watched_at: Option<String>,
    pub last_played_at: Option<String>,
    pub play_count: i64,
    pub thumbnail_path: Option<String>,
    pub added_at: String,
}

pub const EPISODE_COLUMNS: &str = "e.id, e.series_id, s.title, e.file_path, e.origin_path, e.file_name, e.file_size, e.file_mtime, e.source_id, e.season, e.episode, e.episode_end, e.kind, e.title, e.resolution, e.audio_hints, e.subtitle_hints, e.version, e.parsed_series, e.confidence, e.manual, e.sort_index, e.available, e.missing, e.missing_since, e.ignored, e.duration, e.position, e.watched, e.watched_at, e.last_played_at, e.play_count, e.thumbnail_path, e.added_at";

fn json_list(s: Option<String>) -> Vec<String> {
    s.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

pub fn episode_from_row(r: &Row) -> rusqlite::Result<Episode> {
    Ok(Episode {
        id: r.get(0)?,
        series_id: r.get(1)?,
        series_title: r.get(2)?,
        file_path: r.get(3)?,
        origin_path: r.get(4)?,
        file_name: r.get(5)?,
        file_size: r.get(6)?,
        file_mtime: r.get(7)?,
        source_id: r.get(8)?,
        season: r.get(9)?,
        episode: r.get(10)?,
        episode_end: r.get(11)?,
        kind: r.get(12)?,
        title: r.get(13)?,
        resolution: r.get(14)?,
        audio_hints: json_list(r.get(15)?),
        subtitle_hints: json_list(r.get(16)?),
        version: r.get(17)?,
        parsed_series: r.get(18)?,
        confidence: r.get(19)?,
        manual: r.get::<_, i64>(20)? != 0,
        sort_index: r.get(21)?,
        available: r.get::<_, i64>(22)? != 0,
        missing: r.get::<_, i64>(23)? != 0,
        missing_since: r.get(24)?,
        ignored: r.get::<_, i64>(25)? != 0,
        duration: r.get(26)?,
        position: r.get(27)?,
        watched: r.get::<_, i64>(28)? != 0,
        watched_at: r.get(29)?,
        last_played_at: r.get(30)?,
        play_count: r.get(31)?,
        thumbnail_path: r.get(32)?,
        added_at: r.get(33)?,
    })
}

const SERIES_SELECT: &str = r#"
SELECT s.id, s.title, s.alt_title, s.description, s.year, s.genres, s.cover_path, s.banner_path, s.favorite,
       s.sort_index, s.anilist_id, s.metadata_status, s.metadata_locked, s.format, s.score, s.studio, s.total_episodes,
       COUNT(e.id),
       COALESCE(SUM(CASE WHEN e.available=1 AND e.missing=0 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN e.id IS NULL THEN 0 WHEN e.available=1 AND e.missing=0 THEN 0 ELSE 1 END), 0),
       COALESCE(SUM(e.watched), 0),
       COALESCE(SUM(CASE WHEN e.watched=0 AND e.position > 5 THEN 1 ELSE 0 END), 0),
       COUNT(DISTINCT CASE WHEN e.kind='episode' THEN COALESCE(e.season, 1) END),
       MAX(e.last_played_at), MAX(e.added_at), s.created_at, s.updated_at,
       (SELECT l.provider FROM series_links l WHERE l.series_id = s.id ORDER BY l.source = 'user' DESC, l.created_at LIMIT 1)
FROM series s
LEFT JOIN episodes e ON e.series_id = s.id AND e.ignored = 0
"#;

fn series_from_row(r: &Row) -> rusqlite::Result<SeriesSummary> {
    Ok(SeriesSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        alt_title: r.get(2)?,
        description: r.get(3)?,
        year: r.get(4)?,
        genres: json_list(r.get(5)?),
        cover_path: r.get(6)?,
        banner_path: r.get(7)?,
        favorite: r.get::<_, i64>(8)? != 0,
        sort_index: r.get(9)?,
        anilist_id: r.get(10)?,
        metadata_status: r.get(11)?,
        metadata_locked: r.get::<_, i64>(12)? != 0,
        format: r.get(13)?,
        score: r.get(14)?,
        studio: r.get(15)?,
        total_episodes: r.get(16)?,
        episode_count: r.get(17)?,
        available_count: r.get(18)?,
        unavailable_count: r.get(19)?,
        watched_count: r.get(20)?,
        in_progress_count: r.get(21)?,
        season_count: r.get(22)?,
        last_played_at: r.get(23)?,
        last_added_at: r.get(24)?,
        created_at: r.get(25)?,
        updated_at: r.get(26)?,
        online_provider: r.get(27)?,
    })
}

pub fn list_series(conn: &Connection) -> AppResult<Vec<SeriesSummary>> {
    let sql = format!("{SERIES_SELECT} GROUP BY s.id ORDER BY s.title COLLATE NOCASE");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], series_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_series(conn: &Connection, id: &str) -> AppResult<Option<SeriesSummary>> {
    let sql = format!("{SERIES_SELECT} WHERE s.id = ?1 GROUP BY s.id");
    Ok(conn.query_row(&sql, params![id], series_from_row).optional()?)
}

pub fn episodes_where(conn: &Connection, where_sql: &str, order_sql: &str, p: &[&dyn rusqlite::ToSql]) -> AppResult<Vec<Episode>> {
    let sql = format!("SELECT {EPISODE_COLUMNS} FROM episodes e LEFT JOIN series s ON s.id = e.series_id WHERE {where_sql} {order_sql}");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(p, episode_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub const EPISODE_ORDER: &str = "ORDER BY CASE e.kind WHEN 'episode' THEN 0 WHEN 'special' THEN 1 WHEN 'ova' THEN 2 WHEN 'movie' THEN 3 ELSE 4 END, COALESCE(e.season, 1), COALESCE(e.sort_index, e.episode * 100, 999999), e.episode, COALESCE(e.version, 1), e.file_name COLLATE NOCASE";

pub fn get_episode(conn: &Connection, id: &str) -> AppResult<Option<Episode>> {
    Ok(episodes_where(conn, "e.id = ?1", "", &[&id])?.into_iter().next())
}

pub fn series_episodes(conn: &Connection, series_id: &str) -> AppResult<Vec<Episode>> {
    episodes_where(conn, "e.series_id = ?1 AND e.ignored = 0", EPISODE_ORDER, &[&series_id])
}

pub fn list_sources(conn: &Connection) -> AppResult<Vec<Source>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.path, s.kind, s.enabled, s.available, s.added_at, s.last_scan_at,
                (SELECT COUNT(*) FROM episodes e WHERE e.source_id = s.id AND e.ignored = 0)
         FROM sources s ORDER BY s.kind DESC, s.path COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Source {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                enabled: r.get::<_, i64>(3)? != 0,
                available: r.get::<_, i64>(4)? != 0,
                added_at: r.get(5)?,
                last_scan_at: r.get(6)?,
                episode_count: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn add_alias(conn: &Connection, alias: &str, series_id: &str) -> AppResult<()> {
    let norm = crate::parser::normalize_title(alias);
    if !norm.is_empty() {
        conn.execute(
            "INSERT INTO series_aliases(alias_norm, series_id) VALUES(?1, ?2) ON CONFLICT(alias_norm) DO UPDATE SET series_id = excluded.series_id",
            params![norm, series_id],
        )?;
    }
    Ok(())
}

pub fn find_series_by_alias(conn: &Connection, title: &str) -> AppResult<Option<String>> {
    let norm = crate::parser::normalize_title(title);
    Ok(conn
        .query_row("SELECT series_id FROM series_aliases WHERE alias_norm = ?1", params![norm], |r| r.get(0))
        .optional()?)
}

pub fn create_series(conn: &Connection, title: &str, alt_title: Option<&str>, year: Option<u32>) -> AppResult<String> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO series(id, title, alt_title, year, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, title, alt_title, year, ts],
    )?;
    add_alias(conn, title, &id)?;
    if let Some(a) = alt_title {
        add_alias(conn, a, &id)?;
    }
    Ok(id)
}

/// Sucht eine Zuordnungsregel für den Ordner der Datei oder einen übergeordneten Ordner.
pub fn find_rule(conn: &Connection, file: &Path) -> AppResult<Option<(String, Option<i64>)>> {
    let mut dir = file.parent();
    while let Some(d) = dir {
        let s = d.to_string_lossy().to_string();
        let found: Option<(String, Option<i64>)> = conn
            .query_row("SELECT series_id, season FROM assignment_rules WHERE folder_path = ?1", params![s], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
        dir = d.parent();
    }
    Ok(None)
}

pub fn data_file(dir: &Path, rel: &str) -> PathBuf {
    dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}
