//! Untertitel: externe SRT/ASS/SSA/VTT-Dateien und in MKV eingebettete Textuntertitel.
//! Alles wird für den integrierten Player in WebVTT umgewandelt und zwischengespeichert.

use matroska_demuxer::{Frame, MatroskaFile, TrackType};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    pub id: String,
    pub label: String,
    pub language: Option<String>,
    pub source: String,
    pub codec: String,
    pub supported: bool,
    pub default: bool,
}

const SUB_EXT: &[&str] = &["srt", "ass", "ssa", "vtt"];

fn episode_file(app: &AppHandle, id: &str) -> AppResult<PathBuf> {
    let state = app.state::<AppState>();
    let conn = state.db()?;
    let p: String = conn.query_row("SELECT file_path FROM episodes WHERE id = ?1", [id], |r| r.get(0)).map_err(|_| AppError::msg("Episode nicht gefunden"))?;
    Ok(PathBuf::from(p))
}

fn lang_from_name(name: &str) -> Option<String> {
    let l = name.to_lowercase();
    for (keys, code) in [
        (&["ger", "deu", "de", "german", "deutsch"][..], "ger"),
        (&["eng", "en", "english"][..], "eng"),
        (&["jpn", "ja", "jap", "japanese"][..], "jpn"),
        (&["fre", "fra", "fr", "french"][..], "fre"),
        (&["spa", "es", "spanish"][..], "spa"),
        (&["ita", "it", "italian"][..], "ita"),
    ] {
        if l.split(|c: char| !c.is_alphanumeric()).any(|t| keys.contains(&t)) {
            return Some(code.to_string());
        }
    }
    None
}

/// Untertiteldateien neben dem Video bzw. in einem Unterordner "Subs"/"Subtitles".
fn sidecar_files(video: &Path) -> Vec<PathBuf> {
    let Some(dir) = video.parent() else { return vec![] };
    let stem = video.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut out = vec![];
    let mut dirs = vec![dir.to_path_buf()];
    for sub in ["Subs", "Subtitles", "Untertitel", "subs"] {
        let d = dir.join(sub);
        if d.is_dir() {
            dirs.push(d.clone());
            dirs.push(d.join(video.file_stem().unwrap_or_default()));
        }
    }
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
            if !SUB_EXT.contains(&ext.as_str()) {
                continue;
            }
            let name = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            let in_named_folder = d != dir;
            if name.starts_with(&stem) || (in_named_folder && d.file_name().map(|n| n.to_string_lossy().to_lowercase()) == Some(stem.clone())) {
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

pub fn list_tracks(app: &AppHandle, episode_id: &str) -> AppResult<Vec<SubtitleTrack>> {
    let video = episode_file(app, episode_id)?;
    let mut tracks = vec![];
    for (i, p) in sidecar_files(&video).iter().enumerate() {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_uppercase();
        tracks.push(SubtitleTrack {
            id: format!("ext:{i}"),
            label: name.clone(),
            language: lang_from_name(&name.replace(video.file_stem().unwrap_or_default().to_string_lossy().as_ref(), "")),
            source: "external".into(),
            codec: ext,
            supported: true,
            default: false,
        });
    }
    let is_mkv = video.extension().and_then(|e| e.to_str()).map(|e| matches!(e.to_lowercase().as_str(), "mkv" | "webm")).unwrap_or(false);
    if is_mkv && video.exists() {
        if let Ok(f) = File::open(&video) {
            if let Ok(mkv) = MatroskaFile::open(BufReader::new(f)) {
                for t in mkv.tracks().iter().filter(|t| t.track_type() == TrackType::Subtitle) {
                    let codec = t.codec_id().to_string();
                    let supported = matches!(codec.as_str(), "S_TEXT/UTF8" | "S_TEXT/ASS" | "S_TEXT/SSA" | "S_ASS" | "S_SSA" | "S_TEXT/WEBVTT");
                    let lang = t.language_bcp47().or(t.language()).map(|s| s.to_string());
                    let label = match (t.name(), &lang) {
                        (Some(n), Some(l)) => format!("{n} ({l})"),
                        (Some(n), None) => n.to_string(),
                        (None, Some(l)) => l.clone(),
                        (None, None) => format!("Spur {}", t.track_number()),
                    };
                    tracks.push(SubtitleTrack {
                        id: format!("mkv:{}", t.track_number()),
                        label,
                        language: lang,
                        source: "embedded".into(),
                        codec: codec.replace("S_TEXT/", ""),
                        supported,
                        default: t.flag_default(),
                    });
                }
            }
        }
    }
    Ok(tracks)
}

pub fn vtt_for(app: &AppHandle, episode_id: &str, track: &str) -> AppResult<String> {
    let video = episode_file(app, episode_id)?;
    if let Some(i) = track.strip_prefix("ext:") {
        let idx: usize = i.parse().map_err(|_| AppError::msg("Ungültige Spur"))?;
        let files = sidecar_files(&video);
        let p = files.get(idx).ok_or_else(|| AppError::msg("Untertiteldatei nicht gefunden"))?;
        return file_to_vtt(p);
    }
    if let Some(n) = track.strip_prefix("mkv:") {
        let num: u64 = n.parse().map_err(|_| AppError::msg("Ungültige Spur"))?;
        let state = app.state::<AppState>();
        let size = std::fs::metadata(&video).map(|m| m.len()).unwrap_or(0);
        let cache = state.subs_dir().join(format!("{episode_id}_{size}_{num}.vtt"));
        if let Ok(t) = std::fs::read_to_string(&cache) {
            return Ok(t);
        }
        extract_mkv(&video, &state.subs_dir(), episode_id, size)?;
        return std::fs::read_to_string(&cache).map_err(|_| AppError::msg("Diese Untertitelspur enthält keine lesbaren Texte."));
    }
    Err(AppError::msg("Unbekannte Untertitelspur"))
}

/// Liest alle Textuntertitel einer MKV-Datei in einem Durchgang und speichert sie als VTT.
fn extract_mkv(video: &Path, out_dir: &Path, episode_id: &str, size: u64) -> AppResult<()> {
    let f = File::open(video)?;
    let mut mkv = MatroskaFile::open(BufReader::with_capacity(1 << 20, f)).map_err(|e| AppError::msg(format!("MKV konnte nicht gelesen werden: {e:?}")))?;
    let scale = mkv.info().timestamp_scale().get() as f64 / 1_000_000.0;
    let text_tracks: Vec<(u64, bool)> = mkv
        .tracks()
        .iter()
        .filter(|t| t.track_type() == TrackType::Subtitle)
        .filter(|t| t.codec_id().starts_with("S_TEXT") || t.codec_id().starts_with("S_ASS") || t.codec_id().starts_with("S_SSA"))
        .map(|t| (t.track_number().get(), t.codec_id().contains("ASS") || t.codec_id().contains("SSA")))
        .collect();
    if text_tracks.is_empty() {
        return Err(AppError::msg("Keine Textuntertitel in der Datei"));
    }
    let mut cues: std::collections::HashMap<u64, Vec<(f64, f64, String)>> = Default::default();
    let mut frame = Frame::default();
    while mkv.next_frame(&mut frame).map_err(|e| AppError::msg(format!("MKV-Lesefehler: {e:?}")))? {
        let Some((_, is_ass)) = text_tracks.iter().find(|(n, _)| *n == frame.track) else { continue };
        let start = frame.timestamp as f64 * scale;
        let dur = frame.duration.map(|d| d as f64 * scale).unwrap_or(3000.0);
        let raw = decode_text(&frame.data);
        let text = if *is_ass {
            // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
            raw.splitn(9, ',').nth(8).map(ass_text).unwrap_or_default()
        } else {
            strip_html_like(&raw)
        };
        if !text.trim().is_empty() {
            cues.entry(frame.track).or_default().push((start, start + dur, text));
        }
    }
    std::fs::create_dir_all(out_dir)?;
    for (num, _) in &text_tracks {
        let list = cues.remove(num).unwrap_or_default();
        let vtt = build_vtt(list);
        std::fs::write(out_dir.join(format!("{episode_id}_{size}_{num}.vtt")), vtt)?;
    }
    Ok(())
}

fn decode_text(bytes: &[u8]) -> String {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        // Ältere deutsche Untertitel sind oft Windows-1252 kodiert
        Err(_) => b.iter().map(|&c| c as char).collect(),
    }
}

fn fmt_time(ms: f64) -> String {
    let ms = ms.max(0.0) as u64;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

fn build_vtt(mut cues: Vec<(f64, f64, String)>) -> String {
    cues.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    cues.dedup_by(|a, b| a.0 == b.0 && a.2 == b.2);
    let mut out = String::from("WEBVTT\n\n");
    for (s, e, t) in cues {
        out.push_str(&format!("{} --> {}\n{}\n\n", fmt_time(s), fmt_time(e), t.replace("-->", "→")));
    }
    out
}

fn ass_text(s: &str) -> String {
    let re = regex::Regex::new(r"\{[^}]*\}").unwrap();
    let t = re.replace_all(s, "");
    let t = t.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ");
    // Zeichnungen (\p1) liefern nach dem Entfernen der Tags nur Koordinaten
    if s.contains("\\p1") {
        return String::new();
    }
    t.trim().to_string()
}

fn strip_html_like(s: &str) -> String {
    // <i>, <b>, <u> sind in VTT erlaubt; <font> nicht
    let re = regex::Regex::new(r"(?i)</?font[^>]*>").unwrap();
    re.replace_all(s, "").trim().to_string()
}

fn parse_ass_time(t: &str) -> Option<f64> {
    let mut it = t.trim().split(':');
    let h: f64 = it.next()?.parse().ok()?;
    let m: f64 = it.next()?.parse().ok()?;
    let s: f64 = it.next()?.parse().ok()?;
    Some((h * 3600.0 + m * 60.0 + s) * 1000.0)
}

pub fn file_to_vtt(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path)?;
    let text = decode_text(&bytes).replace("\r\n", "\n").replace('\r', "\n");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "vtt" => Ok(text),
        "srt" => {
            let re = regex::Regex::new(r"(\d{1,2}:\d{2}:\d{2}),(\d{3})").unwrap();
            let body = re.replace_all(&text, "$1.$2");
            // Laufende Nummern vor den Zeitstempeln sind in VTT erlaubt (Cue-IDs)
            Ok(format!("WEBVTT\n\n{}", strip_html_like(&body)))
        }
        "ass" | "ssa" => {
            let mut format: Vec<String> = vec![];
            let mut cues = vec![];
            let mut in_events = false;
            for line in text.lines() {
                let l = line.trim();
                if l.starts_with('[') {
                    in_events = l.eq_ignore_ascii_case("[events]");
                    continue;
                }
                if !in_events {
                    continue;
                }
                if let Some(f) = l.strip_prefix("Format:") {
                    format = f.split(',').map(|x| x.trim().to_lowercase()).collect();
                } else if let Some(d) = l.strip_prefix("Dialogue:") {
                    if format.is_empty() {
                        format = "layer,start,end,style,name,marginl,marginr,marginv,effect,text".split(',').map(String::from).collect();
                    }
                    let fields: Vec<&str> = d.splitn(format.len(), ',').collect();
                    let get = |name: &str| format.iter().position(|f| f == name).and_then(|i| fields.get(i)).copied();
                    let (Some(s), Some(e), Some(t)) = (get("start").and_then(parse_ass_time), get("end").and_then(parse_ass_time), get("text")) else { continue };
                    let txt = ass_text(t);
                    if !txt.is_empty() {
                        cues.push((s, e, txt));
                    }
                }
            }
            Ok(build_vtt(cues))
        }
        _ => Err(AppError::msg("Nicht unterstütztes Untertitelformat")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ass_cleanup() {
        assert_eq!(ass_text("{\\an8}Hallo\\NWelt"), "Hallo\nWelt");
        assert_eq!(fmt_time(3_723_456.0), "01:02:03.456");
    }

    #[test]
    fn ass_times() {
        assert_eq!(parse_ass_time("0:01:02.50"), Some(62_500.0));
    }
}
