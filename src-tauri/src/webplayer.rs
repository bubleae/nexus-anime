//! Stream-Links prüfen und Webseiten-Fallback.
//!
//! `probe_stream` lädt nur den Anfang eines Links und erkennt daran, ob es ein Video, ein
//! HLS-Manifest oder eine HTML-Seite ist. Ist es eine Seite und findet kein Resolver-Plugin den
//! Video-Link, kann sie in einem eigenen Fenster („Webansicht“) geöffnet werden. Ein dort in jede
//! Seite und jeden Frame eingefügtes Skript (player_bridge.js) meldet die Video-Links, die der Player
//! der Seite lädt; die App bietet sie dann zum Abspielen im NEXUS-Player an.
//!
//! Das Fenster bekommt keine Rechte für App-Befehle (Capabilities gelten nur für „main“). Meldungen
//! laufen über eine abgefangene Navigation zu `https://nexus-bridge.invalid/…`, die nie geladen wird.

use serde::Serialize;
use std::sync::LazyLock;
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;

type Cmd<T> = Result<T, AppError>;

const WINDOW: &str = "webplayer";
const BRIDGE_HOST: &str = "nexus-bridge.invalid";
const BRIDGE_JS: &str = include_str!("player_bridge.js");
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().user_agent(BROWSER_UA).build().expect("HTTP-Client"));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbe {
    status: u16,
    /// nach Weiterleitungen
    final_url: String,
    content_type: String,
    /// "hls", "file", "dash", "html" oder "unknown"
    kind: &'static str,
}

fn has_ext(url: &str, exts: &[&str]) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    exts.iter().any(|e| path.ends_with(e))
}

/// Erkennt die Art eines Links an Inhaltstyp und Dateianfang.
fn sniff(url: &str, content_type: &str, head: &[u8]) -> &'static str {
    let start = {
        let mut s = head.strip_prefix(b"\xef\xbb\xbf").unwrap_or(head);
        while let [b' ' | b'\t' | b'\r' | b'\n', rest @ ..] = s {
            s = rest;
        }
        s
    };
    let lower: Vec<u8> = start.iter().take(600).map(|b| b.to_ascii_lowercase()).collect();
    let contains = |needle: &[u8]| lower.windows(needle.len()).any(|w| w == needle);
    if start.starts_with(b"#EXTM3U") || content_type.contains("mpegurl") {
        return "hls";
    }
    if content_type.contains("dash+xml") || contains(b"<mpd") {
        return "dash";
    }
    let video_bytes = start.get(4..8) == Some(b"ftyp") || start.starts_with(b"\x1a\x45\xdf\xa3") || (start.len() > 188 && start[0] == 0x47 && start[188] == 0x47);
    if video_bytes || content_type.starts_with("video/") || content_type.starts_with("audio/") {
        return "file";
    }
    if content_type.contains("html") || lower.starts_with(b"<!doctype html") || lower.starts_with(b"<html") || contains(b"<head") {
        return "html";
    }
    if matches!(content_type, "" | "application/octet-stream" | "binary/octet-stream") {
        if has_ext(url, &[".m3u8"]) {
            return "hls";
        }
        if has_ext(url, &[".mp4", ".m4v", ".mkv", ".webm", ".mov"]) {
            return "file";
        }
    }
    "unknown"
}

/// Lädt höchstens 4 KB eines Links und bestimmt, was dahinter liegt.
#[tauri::command(async)]
pub async fn probe_stream(url: String) -> Cmd<StreamProbe> {
    let mut res = CLIENT.get(&url).header(reqwest::header::RANGE, "bytes=0-4095").timeout(Duration::from_secs(15)).send().await?;
    let status = res.status().as_u16();
    let final_url = res.url().to_string();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    let mut head = Vec::new();
    while head.len() < 4096 {
        match res.chunk().await? {
            Some(c) => head.extend_from_slice(&c),
            None => break,
        }
    }
    let kind = if status >= 400 { "unknown" } else { sniff(&final_url, &content_type, &head) };
    Ok(StreamProbe { status, final_url, content_type, kind })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FoundStream {
    url: String,
    page: String,
}

/// Nur http(s) – und nie die eigenen Protokolle (Oberfläche, IPC, Videos), sonst bekäme die Seite App-Rechte.
fn allowed_navigation(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https") && !matches!(u.host_str(), Some("tauri.localhost" | "ipc.localhost" | "nexus.localhost"))
}

/// Öffnet eine Webseite in der Webansicht. Gefundene Video-Links kommen als Ereignis `web-player://found`.
#[tauri::command(async)]
pub fn open_web_player(app: AppHandle, url: String, title: Option<String>) -> Cmd<()> {
    let parsed: Url = url.parse().map_err(|_| AppError::msg("Das ist kein gültiger Link."))?;
    if !allowed_navigation(&parsed) {
        return Err(AppError::msg("Nur http- und https-Links können geöffnet werden."));
    }
    if let Some(win) = app.get_webview_window(WINDOW) {
        win.navigate(parsed).map_err(|e| AppError::msg(e.to_string()))?;
        let _ = win.set_focus();
        return Ok(());
    }
    let handle = app.clone();
    let mut builder = WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::External(parsed));
    // WebView2 teilt den Datenordner nur mit Fenstern, die mit denselben Browser-Argumenten
    // starten – sonst schlägt das Erstellen fehl (0x8007139F). Daher die des Hauptfensters übernehmen.
    if let Some(args) = app.config().app.windows.iter().find(|w| w.label == "main").and_then(|w| w.additional_browser_args.clone()) {
        builder = builder.additional_browser_args(&args);
    }
    builder
        .title(title.unwrap_or_else(|| "NEXUS ANIME – Webansicht".into()))
        .inner_size(1180.0, 720.0)
        .min_inner_size(480.0, 320.0)
        .initialization_script_for_all_frames(BRIDGE_JS)
        .on_navigation(move |u| {
            if u.host_str() == Some(BRIDGE_HOST) {
                let get = |k: &str| u.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned());
                if let (Some(found), Some(page)) = (get("u"), get("p")) {
                    if found.starts_with("http://") || found.starts_with("https://") {
                        let _ = handle.emit_to("main", "web-player://found", FoundStream { url: found, page });
                    }
                }
                return false;
            }
            allowed_navigation(u)
        })
        // Pop-ups (meist Werbung) nicht öffnen
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
        .map_err(|e| AppError::msg(format!("Die Webansicht konnte nicht geöffnet werden: {e}")))?;
    Ok(())
}

#[tauri::command(async)]
pub fn close_web_player(app: AppHandle) -> Cmd<()> {
    if let Some(win) = app.get_webview_window(WINDOW) {
        let _ = win.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffing() {
        assert_eq!(sniff("https://x/a", "application/vnd.apple.mpegurl", b"#EXTM3U\n"), "hls");
        assert_eq!(sniff("https://x/a", "text/plain", b"\xef\xbb\xbf#EXTM3U\n"), "hls");
        assert_eq!(sniff("https://x/a", "application/octet-stream", b"\0\0\0\x20ftypisom"), "file");
        assert_eq!(sniff("https://x/a.mkv", "application/octet-stream", b"\x1a\x45\xdf\xa3"), "file");
        assert_eq!(sniff("https://x/a", "text/html", b"<!DOCTYPE html><html>"), "html");
        assert_eq!(sniff("https://x/a", "", b"\n  <!doctype html>"), "html");
        assert_eq!(sniff("https://x/a.mpd", "application/dash+xml", b"<?xml?><MPD"), "dash");
        assert_eq!(sniff("https://x/a.m3u8?t=1", "", b"garbage"), "hls");
        assert_eq!(sniff("https://x/a", "application/json", b"{}"), "unknown");
    }

    #[test]
    fn navigation_rules() {
        assert!(allowed_navigation(&"https://example.org/x".parse().unwrap()));
        assert!(allowed_navigation(&"http://192.168.1.10:8096/web".parse().unwrap()));
        assert!(!allowed_navigation(&"http://tauri.localhost/".parse().unwrap()));
        assert!(!allowed_navigation(&"tauri://localhost/".parse().unwrap()));
        assert!(!allowed_navigation(&"http://nexus.localhost/video/1".parse().unwrap()));
        assert!(!allowed_navigation(&"file:///C:/x".parse().unwrap()));
    }
}
