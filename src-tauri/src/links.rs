//! Links zu Serien („Wo ansehen?“) – wie Lesezeichen.
//!
//! Die App speichert nur den Link und öffnet ihn im Standardbrowser – Inhalte werden weder
//! ausgelesen noch heruntergeladen. Bekannte Anbieter bekommen Namen und Farbe, alle anderen
//! Links werden mit ihrer Webadresse angezeigt. Automatisch (von AniList) übernommen werden nur
//! offizielle Anbieter.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::{self, now};
use crate::error::{AppError, AppResult};

/// (Schlüssel, Anzeigename, Domains)
const PROVIDERS: &[(&str, &str, &[&str])] = &[
    ("crunchyroll", "Crunchyroll", &["crunchyroll.com"]),
    ("netflix", "Netflix", &["netflix.com"]),
    ("prime", "Prime Video", &["primevideo.com", "amazon.de", "amazon.com", "amazon.co.uk", "amazon.at"]),
    ("adn", "ADN", &["animationdigitalnetwork.com", "animationdigitalnetwork.de", "animationdigitalnetwork.fr"]),
    ("disney", "Disney+", &["disneyplus.com"]),
    ("hidive", "HIDIVE", &["hidive.com"]),
    ("youtube", "YouTube", &["youtube.com", "youtu.be"]),
    ("joyn", "Joyn", &["joyn.de", "joyn.at"]),
    ("rtlplus", "RTL+", &["plus.rtl.de"]),
    ("wow", "WOW", &["wowtv.de"]),
    ("apple", "Apple TV", &["tv.apple.com"]),
    ("animeondemand", "Anime on Demand", &["anime-on-demand.de"]),
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeriesLink {
    pub id: String,
    pub series_id: String,
    pub url: String,
    pub provider: String,
    pub provider_name: String,
    pub source: String,
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS series_links(
           id TEXT PRIMARY KEY,
           series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
           url TEXT NOT NULL,
           provider TEXT NOT NULL,
           source TEXT NOT NULL DEFAULT 'user',
           created_at TEXT NOT NULL,
           UNIQUE(series_id, url)
         );",
    )?;
    Ok(())
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.split('@').last()?.split(':').next()?;
    Some(host.to_ascii_lowercase())
}

/// Liefert (Schlüssel, Name) des Anbieters, wenn der Link zu einem offiziellen Dienst gehört.
pub fn provider_of(url: &str) -> Option<(&'static str, &'static str)> {
    let host = host_of(url)?;
    PROVIDERS.iter().find_map(|(key, name, domains)| {
        domains
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
            .then_some((*key, *name))
    })
}

pub fn provider_name(key: &str) -> &'static str {
    PROVIDERS.iter().find(|(k, _, _)| *k == key).map(|(_, n, _)| *n).unwrap_or("Link")
}

/// Prüft und normalisiert einen eingefügten Link.
pub fn validate(url: &str) -> AppResult<(String, &'static str)> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("Bitte einen Link einfügen."));
    }
    let url = if !url.starts_with("http://") && !url.starts_with("https://") { format!("https://{url}") } else { url.to_string() };
    // Nur Webseiten – keine lokalen Dateien oder Skript-Links
    host_of(&url).filter(|h| h.contains('.') && !h.contains(' ')).ok_or_else(|| AppError::msg("Das ist kein gültiger Weblink."))?;
    Ok((url.clone(), provider_of(&url).map(|p| p.0).unwrap_or("web")))
}

/// Anzeigename eines Links: bekannter Anbieter oder die Webadresse ohne „www.“
pub fn display_name(url: &str, provider: &str) -> String {
    if provider != "web" {
        return provider_name(provider).to_string();
    }
    host_of(url).map(|h| h.trim_start_matches("www.").to_string()).unwrap_or_else(|| "Link".into())
}

/// Vorschlag für den Seriennamen aus dem Link (z. B. „…/series/GG5H5XQ7D/call-of-the-night“).
pub fn title_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let seg = path.trim_end_matches('/').rsplit('/').next()?;
    if seg.len() < 3 || seg.contains('.') || seg.chars().all(|c| c.is_ascii_digit()) || !seg.contains('-') && seg.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let words: Vec<String> = seg
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    (!words.is_empty()).then(|| words.join(" "))
}

pub fn list(conn: &Connection, series_id: &str) -> AppResult<Vec<SeriesLink>> {
    let mut stmt = conn.prepare("SELECT id, series_id, url, provider, source FROM series_links WHERE series_id = ?1 ORDER BY source = 'user' DESC, created_at")?;
    let rows = stmt
        .query_map(params![series_id], |r| {
            let provider: String = r.get(3)?;
            let url: String = r.get(2)?;
            Ok(SeriesLink { id: r.get(0)?, series_id: r.get(1)?, provider_name: display_name(&url, &provider), url, provider, source: r.get(4)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn add(conn: &Connection, series_id: &str, url: &str, source: &str) -> AppResult<()> {
    let (url, provider) = validate(url)?;
    conn.execute(
        "INSERT INTO series_links(id, series_id, url, provider, source, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(series_id, url) DO NOTHING",
        params![db::new_id(), series_id, url, provider, source, now()],
    )?;
    Ok(())
}

/// Ersetzt die automatisch von AniList übernommenen Links einer Serie.
pub fn replace_anilist(conn: &Connection, series_id: &str, urls: &[String]) -> AppResult<()> {
    conn.execute("DELETE FROM series_links WHERE series_id = ?1 AND source = 'anilist'", params![series_id])?;
    for u in urls {
        if provider_of(u).is_some() {
            add(conn, series_id, u, "anilist")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers() {
        assert_eq!(provider_of("https://www.crunchyroll.com/de/series/GG5H5XQ7D/call-of-the-night").map(|p| p.0), Some("crunchyroll"));
        assert_eq!(provider_of("https://www.netflix.com/title/81234567").map(|p| p.0), Some("netflix"));
        assert_eq!(provider_of("https://crunchyroll.com.evil.example/x"), None);
        assert_eq!(validate("crunchyroll.com/de/series/X/name").unwrap().1, "crunchyroll");
        // Beliebige Webseiten werden als einfacher Link gespeichert
        assert_eq!(validate("https://www.example.org/anime/x").unwrap().1, "web");
        assert_eq!(display_name("https://www.example.org/anime/x", "web"), "example.org");
        assert!(validate("file:///C:/x.mp4").is_err());
        assert!(validate("javascript:alert(1)").is_err());
    }

    #[test]
    fn titles() {
        assert_eq!(title_from_url("https://www.crunchyroll.com/de/series/GG5H5XQ7D/call-of-the-night").as_deref(), Some("Call Of The Night"));
        assert_eq!(title_from_url("https://www.netflix.com/title/81234567"), None);
    }
}
