//! Optionale Metadaten über die öffentliche AniList-GraphQL-API.
//!
//! - Es werden ausschließlich Suchbegriffe (Serientitel) übertragen, niemals Dateien.
//! - Anfragen werden auf max. ~25 pro Minute gedrosselt (AniList erlaubt 90, im
//!   gedrosselten Modus 30) und bei HTTP 429 wird `Retry-After` beachtet.
//! - Antworten und Bilder werden lokal zwischengespeichert, damit die App offline nutzbar bleibt.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

use crate::db::{self, now};
use crate::error::{AppError, AppResult};
use crate::parser::normalize_title;
use crate::state::AppState;

const ENDPOINT: &str = "https://graphql.anilist.co";
const MIN_INTERVAL: Duration = Duration::from_millis(2400);
const CACHE_DAYS: i64 = 14;

static LAST_REQUEST: LazyLock<AsyncMutex<Option<Instant>>> = LazyLock::new(|| AsyncMutex::new(None));
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("NEXUS-ANIME/1.0 (lokale Anime-Bibliothek)")
        .timeout(Duration::from_secs(20))
        .build()
        .expect("HTTP-Client")
});

const SEARCH_QUERY: &str = r#"
query ($search: String) {
  Page(perPage: 12) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
      id
      title { romaji english native }
      synonyms
      description(asHtml: false)
      startDate { year }
      genres
      coverImage { extraLarge large medium }
      bannerImage
      episodes
      format
      averageScore
      popularity
      externalLinks { url site type }
      studios(isMain: true) { nodes { name } }
    }
  }
}"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeMatch {
    pub anilist_id: i64,
    pub title_romaji: Option<String>,
    pub title_english: Option<String>,
    pub title_native: Option<String>,
    pub synonyms: Vec<String>,
    pub description: Option<String>,
    pub year: Option<i64>,
    pub genres: Vec<String>,
    pub cover_extra_large: Option<String>,
    pub cover_large: Option<String>,
    pub cover_medium: Option<String>,
    pub banner: Option<String>,
    pub episodes: Option<i64>,
    pub format: Option<String>,
    pub score: Option<i64>,
    pub studio: Option<String>,
    #[serde(default)]
    pub popularity: Option<i64>,
    /// Offizielle Streaming-Links laut AniList
    #[serde(default)]
    pub streaming_links: Vec<String>,
}

fn clean_description(s: &str) -> String {
    let s = s.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n");
    let re = regex::Regex::new(r"<[^>]+>").unwrap();
    let s = re.replace_all(&s, "");
    let s = s.replace("&quot;", "\"").replace("&amp;", "&").replace("&#039;", "'").replace("&lt;", "<").replace("&gt;", ">");
    let re = regex::Regex::new(r"\n{3,}").unwrap();
    re.replace_all(s.trim(), "\n\n").to_string()
}

fn parse_media(m: &serde_json::Value) -> AnimeMatch {
    let s = |v: &serde_json::Value| v.as_str().map(|x| x.to_string());
    AnimeMatch {
        anilist_id: m["id"].as_i64().unwrap_or(0),
        title_romaji: s(&m["title"]["romaji"]),
        title_english: s(&m["title"]["english"]),
        title_native: s(&m["title"]["native"]),
        synonyms: m["synonyms"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
        description: m["description"].as_str().map(clean_description),
        year: m["startDate"]["year"].as_i64(),
        genres: m["genres"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
        cover_extra_large: s(&m["coverImage"]["extraLarge"]),
        cover_large: s(&m["coverImage"]["large"]),
        cover_medium: s(&m["coverImage"]["medium"]),
        banner: s(&m["bannerImage"]),
        episodes: m["episodes"].as_i64(),
        format: s(&m["format"]),
        score: m["averageScore"].as_i64(),
        popularity: m["popularity"].as_i64(),
        streaming_links: m["externalLinks"]
            .as_array()
            .map(|a| a.iter().filter(|l| l["type"] == "STREAMING").filter_map(|l| l["url"].as_str().map(String::from)).collect())
            .unwrap_or_default(),
        studio: m["studios"]["nodes"].as_array().and_then(|a| a.first()).and_then(|n| n["name"].as_str()).map(String::from),
    }
}

async fn throttle() {
    let mut last = LAST_REQUEST.lock().await;
    if let Some(t) = *last {
        let since = t.elapsed();
        if since < MIN_INTERVAL {
            tokio::time::sleep(MIN_INTERVAL - since).await;
        }
    }
    *last = Some(Instant::now());
}

pub async fn search(app: &AppHandle, query: &str) -> AppResult<Vec<AnimeMatch>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let state = app.state::<AppState>();
    let cache_key = format!("search2:{}", normalize_title(query));
    {
        let conn = state.db()?;
        let cached: Option<(String, String)> = conn
            .query_row("SELECT response, fetched_at FROM metadata_cache WHERE query = ?1", params![cache_key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((resp, at)) = cached {
            let fresh = chrono::DateTime::parse_from_rfc3339(&at).map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_days() < CACHE_DAYS).unwrap_or(false);
            if fresh {
                if let Ok(v) = serde_json::from_str::<Vec<AnimeMatch>>(&resp) {
                    return Ok(v);
                }
            }
        }
    }

    let mut attempts = 0;
    let body = loop {
        attempts += 1;
        throttle().await;
        let resp = CLIENT
            .post(ENDPOINT)
            .json(&json!({ "query": SEARCH_QUERY, "variables": { "search": query } }))
            .send()
            .await
            .map_err(|e| AppError::msg(format!("AniList nicht erreichbar ({e}). Besteht eine Internetverbindung?")))?;
        if resp.status().as_u16() == 429 && attempts < 3 {
            let wait = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(30);
            log::warn!("AniList-Ratenlimit erreicht, warte {wait}s");
            tokio::time::sleep(Duration::from_secs(wait.min(90))).await;
            continue;
        }
        if !resp.status().is_success() {
            return Err(AppError::msg(format!("AniList antwortete mit Status {}", resp.status())));
        }
        break resp.json::<serde_json::Value>().await?;
    };
    let results: Vec<AnimeMatch> = body["data"]["Page"]["media"].as_array().map(|a| a.iter().map(parse_media).collect()).unwrap_or_default();
    {
        let conn = state.db()?;
        conn.execute(
            "INSERT INTO metadata_cache(query, response, fetched_at) VALUES(?1, ?2, ?3) ON CONFLICT(query) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at",
            params![cache_key, serde_json::to_string(&results)?, now()],
        )?;
    }
    Ok(results)
}

fn similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (normalize_title(a), normalize_title(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    strsim::jaro_winkler(&a, &b).max(strsim::normalized_levenshtein(&a, &b))
}

/// Vergleicht einen erkannten Titel mit einem Kandidaten. Haupttitel zählen voll, Synonyme
/// nur abgeschwächt (dort tauchen oft Kooperationen oder Spin-offs auf).
fn title_score(query: &str, m: &AnimeMatch) -> f64 {
    let q = normalize_title(query);
    let mains = [m.title_romaji.as_deref(), m.title_english.as_deref(), m.title_native.as_deref()];
    let mut best: f64 = 0.0;
    for n in mains.into_iter().flatten() {
        let n_norm = normalize_title(n);
        let mut s = similarity(query, n);
        // "Demon Slayer" ⊂ "Demon Slayer: Kimetsu no Yaiba"
        if !q.is_empty() && (n_norm.starts_with(&format!("{q} ")) || q.starts_with(&format!("{n_norm} "))) {
            s = s.max(0.93);
        }
        best = best.max(s);
    }
    for syn in &m.synonyms {
        best = best.max(similarity(query, syn) * 0.9);
    }
    best
}

fn best_match(title: &str, alt: Option<&str>, results: &[AnimeMatch]) -> Option<(AnimeMatch, f64)> {
    let max_pop = results.iter().filter_map(|m| m.popularity).max().unwrap_or(1).max(1) as f64;
    let mut best: Option<(AnimeMatch, f64)> = None;
    for (rank, m) in results.iter().enumerate() {
        let mut score = title_score(title, m);
        if let Some(a) = alt {
            score = score.max(title_score(a, m));
        }
        // AniList sortiert nach Suchrelevanz; Beliebtheit bevorzugt die Hauptserie vor Ablegern
        score += 0.04 * (1.0 - rank.min(5) as f64 / 5.0);
        score += 0.03 * (m.popularity.unwrap_or(0) as f64 / max_pop);
        if matches!(m.format.as_deref(), Some("TV") | Some("TV_SHORT")) {
            score += 0.01;
        }
        if best.as_ref().map(|(_, s)| score > *s).unwrap_or(true) {
            best = Some((m.clone(), score));
        }
    }
    best
}

async fn download_image(url: &str, dest_base: &std::path::Path) -> AppResult<String> {
    let resp = CLIENT.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::msg(format!("Bild konnte nicht geladen werden ({})", resp.status())));
    }
    let ext = url.rsplit('.').next().filter(|e| e.len() <= 4).unwrap_or("jpg").to_lowercase();
    let bytes = resp.bytes().await?;
    let path = dest_base.with_extension(ext);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, &bytes)?;
    Ok(path.file_name().unwrap().to_string_lossy().to_string())
}

pub fn preferred_title(m: &AnimeMatch, lang: &str) -> Option<String> {
    match lang {
        "english" => m.title_english.clone().or(m.title_romaji.clone()),
        "native" => m.title_native.clone().or(m.title_romaji.clone()),
        _ => m.title_romaji.clone().or(m.title_english.clone()),
    }
}

/// Übernimmt einen AniList-Eintrag für eine Serie und lädt Cover/Banner herunter.
pub async fn apply_match(app: &AppHandle, series_id: &str, m: &AnimeMatch, rename: bool) -> AppResult<()> {
    let state = app.state::<AppState>();
    let settings = state.settings()?;
    let (custom_cover, custom_banner, old_title): (bool, bool, String) = {
        let conn = state.db()?;
        conn.query_row("SELECT custom_cover, custom_banner, title FROM series WHERE id = ?1", params![series_id], |r| {
            Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)? != 0, r.get(2)?))
        })?
    };
    let version = chrono::Utc::now().timestamp();
    let cover_url = match settings.cover_quality.as_str() {
        "medium" => m.cover_medium.clone().or(m.cover_large.clone()),
        "large" => m.cover_large.clone().or(m.cover_extra_large.clone()),
        _ => m.cover_extra_large.clone().or(m.cover_large.clone()),
    };
    let images = state.images_dir();
    let mut cover_rel = None;
    if !custom_cover {
        if let Some(url) = cover_url {
            match download_image(&url, &images.join(format!("{series_id}_cover_{version}"))).await {
                Ok(name) => cover_rel = Some(format!("images/{name}")),
                Err(e) => log::warn!("Cover-Download fehlgeschlagen: {e}"),
            }
        }
    }
    let mut banner_rel = None;
    if !custom_banner {
        if let Some(url) = &m.banner {
            match download_image(url, &images.join(format!("{series_id}_banner_{version}"))).await {
                Ok(name) => banner_rel = Some(format!("images/{name}")),
                Err(e) => log::warn!("Banner-Download fehlgeschlagen: {e}"),
            }
        }
    }

    let title = if rename { preferred_title(m, &settings.title_language).unwrap_or(old_title.clone()) } else { old_title.clone() };
    let alt = [m.title_english.clone(), m.title_romaji.clone(), m.title_native.clone()].into_iter().flatten().find(|t| normalize_title(t) != normalize_title(&title));
    let conn = state.db()?;
    let old_cover: Option<String> = conn.query_row("SELECT cover_path FROM series WHERE id = ?1", params![series_id], |r| r.get(0))?;
    let old_banner: Option<String> = conn.query_row("SELECT banner_path FROM series WHERE id = ?1", params![series_id], |r| r.get(0))?;
    conn.execute(
        "UPDATE series SET title = ?1, alt_title = ?2, description = ?3, year = ?4, genres = ?5, anilist_id = ?6, format = ?7, score = ?8,
                studio = ?9, total_episodes = ?10, metadata_status = 'matched', updated_at = ?11,
                cover_path = COALESCE(?12, cover_path), banner_path = COALESCE(?13, banner_path)
         WHERE id = ?14",
        params![
            title,
            alt,
            m.description,
            m.year,
            serde_json::to_string(&m.genres)?,
            m.anilist_id,
            m.format,
            m.score,
            m.studio,
            m.episodes,
            now(),
            cover_rel,
            banner_rel,
            series_id
        ],
    )?;
    // Alte Bilder entfernen, wenn sie ersetzt wurden
    for (old, new) in [(old_cover, &cover_rel), (old_banner, &banner_rel)] {
        if let (Some(o), Some(_)) = (old, new) {
            let _ = std::fs::remove_file(db::data_file(&state.data_dir, &o));
        }
    }
    // Offizielle Streaming-Links für „Wo ansehen?“ übernehmen
    crate::links::replace_anilist(&conn, series_id, &m.streaming_links)?;
    // Alle bekannten Titel als Alias speichern, damit künftige Dateien zugeordnet werden
    db::add_alias(&conn, &old_title, series_id)?;
    for t in [&m.title_romaji, &m.title_english].into_iter().flatten() {
        let existing = db::find_series_by_alias(&conn, t)?;
        if existing.is_none() {
            db::add_alias(&conn, t, series_id)?;
        }
    }
    Ok(())
}

/// Lädt für bereits zugeordnete Serien die offiziellen Streaming-Links nach (einmalig pro Serie).
async fn backfill_links(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let todo: Vec<(String, i64)> = {
        let conn = state.db()?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.anilist_id FROM series s WHERE s.anilist_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM metadata_cache c WHERE c.query = 'links:' || s.anilist_id)",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (series_id, anilist_id) in todo {
        throttle().await;
        let body: serde_json::Value = CLIENT
            .post(ENDPOINT)
            .json(&json!({ "query": "query ($id: Int) { Media(id: $id) { externalLinks { url type } } }", "variables": { "id": anilist_id } }))
            .send()
            .await?
            .json()
            .await?;
        let urls: Vec<String> = body["data"]["Media"]["externalLinks"]
            .as_array()
            .map(|a| a.iter().filter(|l| l["type"] == "STREAMING").filter_map(|l| l["url"].as_str().map(String::from)).collect())
            .unwrap_or_default();
        let conn = state.db()?;
        crate::links::replace_anilist(&conn, &series_id, &urls)?;
        conn.execute(
            "INSERT INTO metadata_cache(query, response, fetched_at) VALUES(?1, ?2, ?3) ON CONFLICT(query) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at",
            params![format!("links:{anilist_id}"), serde_json::to_string(&urls)?, now()],
        )?;
        drop(conn);
        let _ = app.emit("metadata://updated", json!({ "seriesId": series_id }));
    }
    Ok(())
}

/// Ruft im Hintergrund Metadaten für alle Serien ab, die noch keine haben.
pub fn start_auto_fetch(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.metadata_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if let Err(e) = auto_fetch_loop(&app).await {
            log::warn!("Automatischer Metadatenabruf unterbrochen: {e}");
        }
        state.metadata_running.store(false, Ordering::SeqCst);
        let _ = app.emit("metadata://done", ());
    });
}

async fn auto_fetch_loop(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    loop {
        let next: Option<(String, String, Option<String>)> = {
            let conn = state.db()?;
            conn.query_row(
                "SELECT id, title, alt_title FROM series WHERE metadata_status = 'pending' AND metadata_locked = 0 ORDER BY created_at LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
        };
        let Some((id, current_title, current_alt)) = next else { return backfill_links(app).await };
        // Bevorzugt den aus den Dateinamen erkannten Namen suchen – so bleibt eine frühere
        // (evtl. falsche) Umbenennung durch Metadaten nicht „kleben“.
        let detected: Option<String> = {
            let conn = state.db()?;
            conn.query_row(
                "SELECT parsed_series FROM episodes WHERE series_id = ?1 AND parsed_series IS NOT NULL AND manual = 0
                 GROUP BY parsed_series ORDER BY COUNT(*) DESC LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
        };
        let (title, alt) = match detected {
            Some(d) if normalize_title(&d) != normalize_title(&current_title) => (d, None),
            _ => (current_title.clone(), current_alt),
        };
        let _ = app.emit("metadata://progress", json!({ "seriesId": id, "title": title }));
        let mut results = search(app, &title).await?;
        if results.is_empty() {
            if let Some(a) = &alt {
                results = search(app, a).await?;
            }
        }
        match best_match(&title, alt.as_deref(), &results) {
            Some((m, score)) if score >= 0.9 => {
                apply_match(app, &id, &m, true).await?;
                log::info!("Metadaten zugeordnet: {title} → {:?} ({score:.2})", m.title_romaji);
            }
            _ => {
                let conn = state.db()?;
                conn.execute("UPDATE series SET metadata_status = 'notfound' WHERE id = ?1", params![id])?;
                log::info!("Keine sicheren Metadaten gefunden für: {title}");
            }
        }
        let _ = app.emit("metadata://updated", json!({ "seriesId": id }));
    }
}


// ---------------------------------------------------------------------------
// Entdecken: Episodenliste einer AniList-Serie (nur Metadaten, keine Videos)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverEpisode {
    pub number: i64,
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    /// Offizieller Link zur Folge (z. B. Crunchyroll), falls bekannt
    pub url: Option<String>,
    pub site: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverDetail {
    pub total: Option<i64>,
    pub aired: Option<i64>,
    pub status: Option<String>,
    pub episodes: Vec<DiscoverEpisode>,
}

const EPISODES_QUERY: &str = "query ($id: Int) { Media(id: $id, type: ANIME) { episodes status nextAiringEpisode { episode } streamingEpisodes { title thumbnail url site } } }";

pub async fn discover_episodes(app: &AppHandle, anilist_id: i64) -> AppResult<DiscoverDetail> {
    let state = app.state::<AppState>();
    let key = format!("episodes:{anilist_id}");
    {
        let conn = state.db()?;
        let cached: Option<(String, String)> = conn
            .query_row("SELECT response, fetched_at FROM metadata_cache WHERE query = ?1", params![key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((resp, at)) = cached {
            let fresh = chrono::DateTime::parse_from_rfc3339(&at).map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_hours() < 24).unwrap_or(false);
            if fresh {
                if let Ok(v) = serde_json::from_str(&resp) {
                    return Ok(v);
                }
            }
        }
    }
    throttle().await;
    let resp = CLIENT
        .post(ENDPOINT)
        .json(&json!({ "query": EPISODES_QUERY, "variables": { "id": anilist_id } }))
        .send()
        .await
        .map_err(|e| AppError::msg(format!("AniList nicht erreichbar ({e}). Besteht eine Internetverbindung?")))?;
    if !resp.status().is_success() {
        return Err(AppError::msg(format!("AniList antwortete mit Status {}", resp.status())));
    }
    let body: serde_json::Value = resp.json().await?;
    let m = &body["data"]["Media"];
    let re = regex::Regex::new(r"(?i)^\s*(?:episode|ep\.?|folge)\s*(\d+)\s*[-–:]?\s*(.*)$").unwrap();
    let mut official: std::collections::BTreeMap<i64, DiscoverEpisode> = Default::default();
    for e in m["streamingEpisodes"].as_array().cloned().unwrap_or_default() {
        let raw = e["title"].as_str().unwrap_or("");
        if let Some(c) = re.captures(raw) {
            let n: i64 = c[1].parse().unwrap_or(0);
            let title = c.get(2).map(|t| t.as_str().trim().to_string()).filter(|t| !t.is_empty());
            official.entry(n).or_insert(DiscoverEpisode {
                number: n,
                title,
                thumbnail: e["thumbnail"].as_str().map(String::from),
                url: e["url"].as_str().map(|u| u.replacen("http://", "https://", 1)),
                site: e["site"].as_str().map(String::from),
            });
        }
    }
    let total = m["episodes"].as_i64();
    let aired = m["nextAiringEpisode"]["episode"].as_i64().map(|n| n - 1);
    let count = total.or(aired).or(official.keys().max().copied()).unwrap_or(0);
    let episodes = (1..=count)
        .map(|n| official.remove(&n).unwrap_or(DiscoverEpisode { number: n, title: None, thumbnail: None, url: None, site: None }))
        .collect();
    let detail = DiscoverDetail { total, aired, status: m["status"].as_str().map(String::from), episodes };
    let conn = state.db()?;
    conn.execute(
        "INSERT INTO metadata_cache(query, response, fetched_at) VALUES(?1, ?2, ?3) ON CONFLICT(query) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at",
        params![key, serde_json::to_string(&detail)?, now()],
    )?;
    Ok(detail)
}

/// Übernimmt eine entdeckte Serie in die Bibliothek (Online-Serie mit Cover, Infos und Links).
pub async fn discover_add(app: &AppHandle, m: &AnimeMatch) -> AppResult<String> {
    let state = app.state::<AppState>();
    let lang = state.settings()?.title_language;
    let id = {
        let conn = state.db()?;
        let existing: Option<String> = conn
            .query_row("SELECT id FROM series WHERE anilist_id = ?1", params![m.anilist_id], |r| r.get(0))
            .optional()?;
        let found = match existing {
            Some(id) => Some(id),
            None => [m.title_romaji.as_deref(), m.title_english.as_deref()].into_iter().flatten().find_map(|t| db::find_series_by_alias(&conn, t).ok().flatten()),
        };
        match found {
            Some(id) => id,
            None => {
                let title = preferred_title(m, &lang).unwrap_or_else(|| "Unbenannt".into());
                let id = db::create_series(&conn, &title, None, m.year.map(|y| y as u32))?;
                conn.execute("UPDATE series SET user_created = 1 WHERE id = ?1", params![id])?;
                id
            }
        }
    };
    apply_match(app, &id, m, true).await?;
    state.db()?.execute("UPDATE series SET metadata_locked = 1 WHERE id = ?1", params![id])?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(romaji: &str, english: Option<&str>, syn: &[&str], pop: i64) -> AnimeMatch {
        AnimeMatch {
            anilist_id: pop, title_romaji: Some(romaji.into()), title_english: english.map(String::from), title_native: None,
            synonyms: syn.iter().map(|s| s.to_string()).collect(), description: None, year: None, genres: vec![],
            cover_extra_large: None, cover_large: None, cover_medium: None, banner: None, episodes: None,
            format: Some("TV".into()), score: None, studio: None, popularity: Some(pop), streaming_links: vec![],
        }
    }

    #[test]
    fn prefers_main_title_over_synonym() {
        let results = vec![
            mk("Onigiri", None, &["Demon Slayer"], 5_000),
            mk("Kimetsu no Yaiba", Some("Demon Slayer: Kimetsu no Yaiba"), &[], 900_000),
        ];
        let (m, _) = best_match("Demon Slayer", None, &results).unwrap();
        assert_eq!(m.title_romaji.as_deref(), Some("Kimetsu no Yaiba"));
    }

    #[test]
    fn similarity_works() {
        assert!(similarity("Shingeki no Kyojin", "Shingeki no Kyojin") > 0.99);
        assert!(similarity("Demon Slayer", "Kimetsu no Yaiba") < 0.7);
    }

    #[test]
    fn description_cleanup() {
        assert_eq!(clean_description("A<br><br>B <i>c</i> &amp; d"), "A\n\nB c & d");
    }
}
