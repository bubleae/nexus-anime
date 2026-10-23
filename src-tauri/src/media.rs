//! Eigenes URI-Schema `nexus://` (unter Windows: http://nexus.localhost/...).
//!
//! - `/video/<episode-id>`   streamt die Originaldatei mit HTTP-Range-Unterstützung (keine Kopie)
//! - `/img/<relativer Pfad>` liefert Cover, Banner und Vorschaubilder aus dem Datenordner
//! - `/sub/<episode-id>/<track>` liefert Untertitel als WebVTT
//!
//! Videos werden nur über ihre Episoden-ID adressiert, sodass die Weboberfläche
//! keine beliebigen Dateien des Systems lesen kann.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const MAX_CHUNK: u64 = 4 * 1024 * 1024;

pub fn handle(app: &AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = percent_encoding::percent_decode_str(req.uri().path()).decode_utf8_lossy().to_string();
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let kind = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("");
    let state = app.state::<AppState>();
    let result = match kind {
        "video" => video_path(&state, rest).and_then(|p| serve_file(&p, req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()), true)),
        "img" => {
            let rel = rest.split('?').next().unwrap_or("");
            if rel.contains("..") {
                Err(error(StatusCode::FORBIDDEN, "forbidden"))
            } else {
                serve_file(&crate::db::data_file(&state.data_dir, rel), None, false)
            }
        }
        "sub" => {
            let mut it = rest.splitn(2, '/');
            let id = it.next().unwrap_or("");
            let track = it.next().unwrap_or("");
            match crate::subtitles::vtt_for(app, id, track) {
                Ok(text) => Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/vtt; charset=utf-8")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(text.into_bytes())
                    .unwrap()),
                Err(e) => Err(error(StatusCode::NOT_FOUND, &e.to_string())),
            }
        }
        _ => Err(error(StatusCode::NOT_FOUND, "not found")),
    };
    result.unwrap_or_else(|r| r)
}

fn error(code: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

fn video_path(state: &AppState, id: &str) -> Result<PathBuf, Response<Vec<u8>>> {
    let conn = state.db().map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let path: String = conn
        .query_row("SELECT file_path FROM episodes WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|_| error(StatusCode::NOT_FOUND, "Episode unbekannt"))?;
    Ok(PathBuf::from(path))
}

pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("wmv") => "video/x-ms-wmv",
        Some("ogv") => "video/ogg",
        Some("ts") | Some("m2ts") => "video/mp2t",
        Some("mpg") | Some("mpeg") => "video/mpeg",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

fn serve_file(path: &Path, range: Option<&str>, video: bool) -> Result<Response<Vec<u8>>, Response<Vec<u8>>> {
    let mut file = File::open(path).map_err(|e| error(StatusCode::NOT_FOUND, &format!("Datei nicht verfügbar: {e}")))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = mime_for(path);
    if !video {
        let mut buf = Vec::with_capacity(len as usize);
        file.read_to_end(&mut buf).map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "max-age=31536000")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(buf)
            .unwrap());
    }
    // Range auswerten: "bytes=start-end"
    let (start, end) = match range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split(',').next()) {
        Some(spec) => {
            let mut it = spec.splitn(2, '-');
            let s = it.next().unwrap_or("").trim();
            let e = it.next().unwrap_or("").trim();
            if s.is_empty() {
                // Suffix-Range: die letzten N Bytes
                let n: u64 = e.parse().unwrap_or(0).min(len);
                (len - n, len.saturating_sub(1))
            } else {
                let s: u64 = s.parse().unwrap_or(0);
                let e: u64 = if e.is_empty() { len.saturating_sub(1) } else { e.parse().unwrap_or(len.saturating_sub(1)) };
                (s, e.min(len.saturating_sub(1)))
            }
        }
        None => (0, len.saturating_sub(1)),
    };
    if start >= len && len > 0 {
        return Err(Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(vec![])
            .unwrap());
    }
    let end = end.min(start + MAX_CHUNK - 1);
    let size = end - start + 1;
    file.seek(SeekFrom::Start(start)).map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let mut buf = vec![0u8; size as usize];
    file.read_exact(&mut buf).map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(header::CONTENT_LENGTH, size.to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
        .body(buf)
        .unwrap())
}
