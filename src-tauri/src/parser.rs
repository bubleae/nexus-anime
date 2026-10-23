//! Analyse von Anime-Dateinamen und Ordnerstrukturen.
//!
//! Das Modul ist bewusst frei von Datenbank- oder Dateisystemzugriffen, damit es
//! isoliert getestet werden kann. Eingabe ist der Dateipfad und (optional) der
//! Quellordner, in dem er gefunden wurde.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::LazyLock;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "avi", "mov", "webm", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg", "ogv", "3gp",
];

pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EpisodeKind {
    Episode,
    Special,
    Ova,
    Movie,
    Extra,
}

impl EpisodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EpisodeKind::Episode => "episode",
            EpisodeKind::Special => "special",
            EpisodeKind::Ova => "ova",
            EpisodeKind::Movie => "movie",
            EpisodeKind::Extra => "extra",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "special" => EpisodeKind::Special,
            "ova" => EpisodeKind::Ova,
            "movie" => EpisodeKind::Movie,
            "extra" => EpisodeKind::Extra,
            _ => EpisodeKind::Episode,
        }
    }
}

/// Woher der Serienname stammt – bestimmt, wie sicher die Zuordnung ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameSource {
    Filename,
    Folder,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedFile {
    pub series_title: Option<String>,
    pub alt_title: Option<String>,
    pub name_source: NameSource,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_end: Option<u32>,
    pub episode_title: Option<String>,
    pub kind: EpisodeKind,
    pub resolution: Option<String>,
    pub audio_hints: Vec<String>,
    pub subtitle_hints: Vec<String>,
    pub version: Option<u32>,
    pub year: Option<u32>,
    /// 0.0 – 1.0. Unterhalb von [`AUTO_ASSIGN_THRESHOLD`] landet die Datei bei den unsortierten Dateien.
    pub confidence: f32,
}

pub const AUTO_ASSIGN_THRESHOLD: f32 = 0.6;

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(BRACKETS, r"\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\}|【([^】]*)】");
re!(RESOLUTION, r"(?i)\b(2160|1440|1080|720|576|540|480|360)[pi]\b|\b(4k|uhd|fhd|hd)\b|\b(\d{3,4})x(\d{3,4})\b");
re!(CRC, r"(?i)^[0-9a-f]{8}$");
re!(YEAR, r"^(19[5-9]\d|20[0-4]\d)$");
re!(VERSION_SUFFIX, r"(?i)^(\d+)v(\d)$");
re!(
    NOISE,
    r"(?i)\b(x264|x265|h\.?264|h\.?265|hevc|avc|10[- ]?bits?|8[- ]?bits?|hi10p?|aac(?:2\.0)?|ac3|eac3|e-ac-3|flac|opus|dts(?:-hd)?|truehd|ddp?5\.1|dd2\.0|2\.0|5\.1|bluray|blu-ray|bdrip|bd|brrip|web-?dl|web-?rip|webrip|web|hdtv|dvdrip|dvd|remux|uncensored|uncut|cr|crunchyroll|amzn|nf|dsnp|adn|vrv|funi|hidive|multi-?subs?|batch|complete|repack|proper|dual[- ]?audio|multi[- ]?audio)\b"
);
re!(AUDIO_HINT, r"(?i)\b(ger(?:man)?[ ._-]?dub|deutsch|german|ger|eng(?:lish)?[ ._-]?dub|english|jap(?:anese)?|jpn|dual[ ._-]?audio|multi[ ._-]?audio|dub(?:bed)?)\b");
re!(SUB_HINT, r"(?i)\b(ger(?:man)?[ ._-]?sub(?:s|bed)?|eng(?:lish)?[ ._-]?sub(?:s|bed)?|omu|omdu|ov|sub(?:bed|s)?|multi[ ._-]?subs?|softsubs?|hardsubs?)\b");

// Episoden-Muster (auf bereinigtem Namen ohne Klammern und mit Leerzeichen statt _ / .)
re!(SXXEXX, r"(?i)\bS(\d{1,2})[ ._-]*E[Pp]?[ ._-]?(\d{1,4})(?:[ ._-]*(?:-|E|~)[ ._-]*E?(\d{1,4}))?(?:v(\d))?\b");
re!(NXN, r"(?i)\b(\d{1,2})x(\d{1,4})(?:v(\d))?\b");
re!(
    SEASON_WORD_EP,
    r"(?i)\b(?:season|staffel|saison|temporada|s)[ ._-]*(\d{1,2})[ ._-]*(?:-[ ._-]*)?(?:episode|episodio|folge|ep|e|#)[ ._-]*(\d{1,4})(?:[ ._-]*(?:-|~)[ ._-]*(\d{1,4}))?(?:v(\d))?\b"
);
re!(
    EP_WORD,
    r"(?i)(?:^|\b|_)(?:episode|episodio|folge|ep|e|#)[ ._-]*(\d{1,4})(?:[ ._-]*(?:-|~)[ ._-]*(\d{1,4}))?(?:v(\d))?\b"
);
// "10ep", "10 ep", "10. Folge" – Nummer vor dem Episodenwort
re!(NUM_EP, r"(?i)(?:^|\s|_)(\d{1,4})(?:v(\d))?\.?[ ._-]?(?:ep|eps|episode|episodio|folge)\b");
re!(DASH_NUM, r"(?:^|\s)[-–—]\s*(\d{1,4})(?:v(\d))?(?:\s*[-–—~]\s*(\d{1,4}))?(?:\s|$)");
re!(TRAILING_NUM, r"(?:^|\s)(\d{1,4})(?:v(\d))?\s*$");
re!(LEADING_NUM, r"^(\d{1,4})(?:v(\d))?(?:\s+[-–—]?\s*(.*))?$");
re!(SPECIAL_WORD, r"(?i)\b(ova|oad|ona|special|specials|sp|movie|film|the movie|gekijouban|ncop|nced|creditless|opening|ending|preview|trailer|pv|recap|extra|extras|bonus|omake)\b(?:[ ._-]*(\d{1,3}))?");

// Staffel-Hinweise im Seriennamen / Ordnernamen
re!(SEASON_IN_NAME, r"(?i)(?:\b(?:season|staffel|saison|temporada)[ ._-]*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)[ ._-]+season\b|\bS(\d{1,2})\b|\b(?:part|cour|teil)[ ._-]*(\d)\b)");
re!(SEASON_FOLDER, r"(?i)^(?:season|staffel|saison|temporada|s)[ ._-]*(\d{1,2})(?:\b.*)?$|^(\d{1,2})(?:st|nd|rd|th)[ ._-]+season$");
re!(
    GENERIC_FOLDER,
    r"(?i)^(?:specials?|extras?|bonus|ova|ovas|oad|movies?|filme?|disc[ ._-]*\d+|cd[ ._-]*\d+|dvd[ ._-]*\d+|vol(?:ume)?[ ._-]*\d+|subs?|subtitles?|untertitel|featurettes?|ncop|nced|anime|animes|serien|series|downloads?|videos?|tv|tv[ ._-]?shows?|completed|new folder|neuer ordner|\d+p)$"
);
re!(MULTI_SPACE, r"\s{2,}");
re!(EDGE_JUNK, r"^[\s\-–—_.,:;~+|]+|[\s\-–—_.,:;~+|]+$");

#[derive(Default)]
struct Tags {
    resolution: Option<String>,
    audio: Vec<String>,
    subs: Vec<String>,
    year: Option<u32>,
    alt_title: Option<String>,
}

fn push_unique(v: &mut Vec<String>, s: String) {
    if !v.iter().any(|x| x.eq_ignore_ascii_case(&s)) {
        v.push(s);
    }
}

fn normalize_hint(s: &str) -> String {
    let l = s.to_lowercase().replace(['.', '_', '-'], " ");
    let l = l.trim();
    match l {
        "ger" | "german" | "deutsch" => "Deutsch".into(),
        "jap" | "jpn" | "japanese" => "Japanisch".into(),
        "english" => "Englisch".into(),
        "ov" => "OV".into(),
        "omu" => "OmU".into(),
        "omdu" => "OmdU".into(),
        _ => {
            if l.starts_with("ger") && l.contains("dub") {
                "Deutsch (Dub)".into()
            } else if l.starts_with("eng") && l.contains("dub") {
                "Englisch (Dub)".into()
            } else if l.starts_with("ger") && l.contains("sub") {
                "Deutsch (Sub)".into()
            } else if l.starts_with("eng") && l.contains("sub") {
                "Englisch (Sub)".into()
            } else if l.contains("dual") {
                "Dual Audio".into()
            } else if l.contains("multi") && l.contains("sub") {
                "Multi-Sub".into()
            } else if l.contains("multi") {
                "Multi Audio".into()
            } else {
                s.trim().to_string()
            }
        }
    }
}

fn collect_hints(text: &str, tags: &mut Tags) {
    if tags.resolution.is_none() {
        if let Some(c) = RESOLUTION.captures(text) {
            tags.resolution = Some(if let Some(r) = c.get(1) {
                format!("{}p", r.as_str())
            } else if let Some(k) = c.get(2) {
                match k.as_str().to_lowercase().as_str() {
                    "4k" | "uhd" => "2160p".into(),
                    "fhd" => "1080p".into(),
                    _ => "720p".into(),
                }
            } else {
                format!("{}p", c.get(4).map(|m| m.as_str()).unwrap_or(""))
            });
        }
    }
    for c in SUB_HINT.captures_iter(text) {
        push_unique(&mut tags.subs, normalize_hint(&c[1]));
    }
    for c in AUDIO_HINT.captures_iter(text) {
        let h = &c[1];
        // "GerSub" wurde bereits als Untertitel erfasst
        let lower = h.to_lowercase();
        if lower == "ger" || lower == "german" || lower == "deutsch" {
            if SUB_HINT.is_match(text) && text.to_lowercase().contains("sub") {
                continue;
            }
        }
        push_unique(&mut tags.audio, normalize_hint(h));
    }
}

/// Entfernt Klammerinhalte, sammelt dabei Auflösung, Sprache, Jahr und ggf. alternativen Titel.
fn strip_brackets(input: &str, tags: &mut Tags, keep_title_brackets: bool) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    for c in BRACKETS.captures_iter(input) {
        let m = c.get(0).unwrap();
        out.push_str(&input[last..m.start()]);
        out.push(' ');
        last = m.end();
        let inner = c.get(1).or(c.get(2)).or(c.get(3)).or(c.get(4)).map(|x| x.as_str().trim()).unwrap_or("");
        collect_hints(inner, tags);
        if YEAR.is_match(inner) {
            tags.year = inner.parse().ok();
        } else if keep_title_brackets
            && m.as_str().starts_with('(')
            && tags.alt_title.is_none()
            && inner.chars().filter(|c| c.is_alphabetic()).count() >= 4
            && !NOISE.is_match(inner)
            && !RESOLUTION.is_match(inner)
            && !AUDIO_HINT.is_match(inner)
            && !SUB_HINT.is_match(inner)
        {
            tags.alt_title = Some(inner.to_string());
        }
    }
    out.push_str(&input[last..]);
    out
}

fn tidy(s: &str) -> String {
    let s = MULTI_SPACE.replace_all(s.trim(), " ");
    EDGE_JUNK.replace_all(&s, "").trim().to_string()
}

/// Ersetzt Unterstriche und Punkte durch Leerzeichen, wenn der Name keine Leerzeichen nutzt.
fn despace(s: &str) -> String {
    let underscores = s.matches('_').count();
    let dots = s.matches('.').count();
    let spaces = s.matches(' ').count();
    let mut r = s.to_string();
    if underscores > 0 {
        r = r.replace('_', " ");
    }
    if dots >= 2 && dots > spaces {
        // "Naruto.S01E02.1080p" -> Punkte sind Trenner; Dezimalzahlen wie 5.1 entfernt NOISE vorher
        r = r.replace('.', " ");
    } else {
        // einzelne Punkte am Wortende ("Vol.") bleiben
    }
    r
}

fn clean_series_name(raw: &str, tags: &mut Tags) -> (String, Option<u32>) {
    let mut s = NOISE.replace_all(raw, " ").to_string();
    s = RESOLUTION.replace_all(&s, " ").to_string();
    // Jahreszahl am Ende als Jahr übernehmen ("Hunter x Hunter 2011")
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.len() > 1 {
        if let Some(last) = words.last() {
            if YEAR.is_match(last) {
                tags.year = tags.year.or(last.parse().ok());
                s = words[..words.len() - 1].join(" ");
            }
        }
    }
    let mut season = None;
    if let Some(c) = SEASON_IN_NAME.captures(&s) {
        let n = c.get(1).or(c.get(2)).or(c.get(3)).or(c.get(4)).and_then(|m| m.as_str().parse::<u32>().ok());
        let m = c.get(0).unwrap();
        // "Part 2" nur als Staffel deuten, wenn es am Ende steht
        let is_part = m.as_str().to_lowercase().starts_with("part") || m.as_str().to_lowercase().starts_with("cour") || m.as_str().to_lowercase().starts_with("teil");
        if !is_part || s[m.end()..].trim().is_empty() {
            if !is_part {
                season = n;
            }
            if !is_part {
                s = format!("{} {}", &s[..m.start()], &s[m.end()..]);
            }
        }
    }
    (tidy(&s), season)
}

fn clean_episode_title(raw: &str) -> Option<String> {
    let s = NOISE.replace_all(raw, " ");
    let s = RESOLUTION.replace_all(&s, " ");
    let s = AUDIO_HINT.replace_all(&s, " ");
    let s = SUB_HINT.replace_all(&s, " ");
    let t = tidy(&s);
    if t.chars().filter(|c| c.is_alphabetic()).count() >= 2 && !CRC.is_match(&t) {
        Some(t)
    } else {
        None
    }
}

struct EpMatch {
    start: usize,
    end: usize,
    season: Option<u32>,
    episode: u32,
    episode_end: Option<u32>,
    version: Option<u32>,
    strong: bool,
}

fn num(c: &regex::Captures, i: usize) -> Option<u32> {
    c.get(i).and_then(|m| m.as_str().parse().ok())
}

fn find_episode(s: &str) -> Option<EpMatch> {
    if let Some(c) = SXXEXX.captures(s) {
        let m = c.get(0).unwrap();
        return Some(EpMatch { start: m.start(), end: m.end(), season: num(&c, 1), episode: num(&c, 2)?, episode_end: num(&c, 3), version: num(&c, 4), strong: true });
    }
    if let Some(c) = SEASON_WORD_EP.captures(s) {
        let m = c.get(0).unwrap();
        return Some(EpMatch { start: m.start(), end: m.end(), season: num(&c, 1), episode: num(&c, 2)?, episode_end: num(&c, 3), version: num(&c, 4), strong: true });
    }
    if let Some(c) = NXN.captures(s) {
        let m = c.get(0).unwrap();
        return Some(EpMatch { start: m.start(), end: m.end(), season: num(&c, 1), episode: num(&c, 2)?, episode_end: None, version: num(&c, 3), strong: true });
    }
    if let Some(c) = EP_WORD.captures(s) {
        let m = c.get(0).unwrap();
        // "E" alleine nur akzeptieren, wenn direkt Ziffern folgen (z. B. "E05"), nicht "Folge E"
        return Some(EpMatch { start: m.start(), end: m.end(), season: None, episode: num(&c, 1)?, episode_end: num(&c, 2), version: num(&c, 3), strong: true });
    }
    if let Some(c) = NUM_EP.captures(s) {
        let m = c.get(0).unwrap();
        return Some(EpMatch { start: m.start(), end: m.end(), season: None, episode: num(&c, 1)?, episode_end: None, version: num(&c, 2), strong: true });
    }
    if let Some(c) = DASH_NUM.captures(s) {
        let m = c.get(0).unwrap();
        let ep: u32 = num(&c, 1)?;
        let text = &s[..m.start()];
        if !(YEAR.is_match(&ep.to_string()) && text.trim().is_empty()) {
            return Some(EpMatch { start: m.start(), end: m.end(), season: None, episode: ep, episode_end: num(&c, 3), version: num(&c, 2), strong: true });
        }
    }
    // Versionierte Episodennummer irgendwo im Namen ("Name 05v2 Titel")
    for tok in s.split_whitespace() {
        if let Some(c) = VERSION_SUFFIX.captures(tok) {
            if let Some(pos) = s.find(tok) {
                return Some(EpMatch { start: pos, end: pos + tok.len(), season: None, episode: num(&c, 1)?, episode_end: None, version: num(&c, 2), strong: true });
            }
        }
    }
    if let Some(c) = LEADING_NUM.captures(s) {
        let ep: u32 = num(&c, 1)?;
        if !YEAR.is_match(&ep.to_string()) {
            let m1 = c.get(1).unwrap();
            let end = c.get(2).map(|m| m.end()).unwrap_or(m1.end());
            return Some(EpMatch { start: 0, end, season: None, episode: ep, episode_end: None, version: num(&c, 2), strong: false });
        }
    }
    if let Some(c) = TRAILING_NUM.captures(s) {
        let ep: u32 = num(&c, 1)?;
        let m = c.get(0).unwrap();
        if !YEAR.is_match(&ep.to_string()) && !s[..m.start()].trim().is_empty() {
            return Some(EpMatch { start: m.start(), end: m.end(), season: None, episode: ep, episode_end: None, version: num(&c, 2), strong: true });
        }
    }
    None
}

/// Liefert Seriennamen und Staffel aus den übergeordneten Ordnern (bis zum Quellordner).
pub fn folder_context(path: &Path, root: Option<&Path>) -> (Option<String>, Option<u32>, Option<EpisodeKind>) {
    let mut season = None;
    let mut kind = None;
    let mut dir = path.parent();
    let mut depth = 0;
    while let Some(d) = dir {
        if let Some(r) = root {
            // Der Quellordner selbst (z. B. "D:\Anime") ist kein Serienname
            if d == r || !d.starts_with(r) {
                break;
            }
        }
        if depth > 6 {
            break;
        }
        let name = match d.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => break,
        };
        let mut tags = Tags::default();
        let stripped = tidy(&despace(&strip_brackets(name, &mut tags, false)));
        if let Some(c) = SEASON_FOLDER.captures(&stripped) {
            if season.is_none() {
                season = num(&c, 1).or(num(&c, 2));
            }
        } else if GENERIC_FOLDER.is_match(&stripped) {
            let l = stripped.to_lowercase();
            if kind.is_none() {
                if l.starts_with("special") {
                    kind = Some(EpisodeKind::Special);
                } else if l.starts_with("ova") || l.starts_with("oad") {
                    kind = Some(EpisodeKind::Ova);
                } else if l.starts_with("movie") || l.starts_with("film") {
                    kind = Some(EpisodeKind::Movie);
                } else if l.starts_with("extra") || l.starts_with("bonus") || l.starts_with("featurette") || l.starts_with("nc") {
                    kind = Some(EpisodeKind::Extra);
                }
            }
        } else if !stripped.is_empty() {
            let (clean, s) = clean_series_name(&stripped, &mut tags);
            if season.is_none() {
                season = s;
            }
            if clean.chars().any(|c| c.is_alphabetic()) {
                return (Some(clean), season, kind);
            }
        }
        dir = d.parent();
        depth += 1;
    }
    (None, season, kind)
}

pub fn parse_path(path: &Path, root: Option<&Path>) -> ParsedFile {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let mut tags = Tags::default();
    collect_hints(&stem.replace(['_', '.'], " "), &mut tags);
    let no_brackets = strip_brackets(&stem, &mut tags, true);
    let mut s = despace(&no_brackets);
    s = NOISE.replace_all(&s, " ").to_string();
    s = RESOLUTION.replace_all(&s, " ").to_string();
    s = AUDIO_HINT.replace_all(&s, " ").to_string();
    s = SUB_HINT.replace_all(&s, " ").to_string();
    s = MULTI_SPACE.replace_all(s.trim(), " ").to_string();

    let (folder_name, folder_season, folder_kind) = folder_context(path, root);

    let mut kind = EpisodeKind::Episode;
    let mut season = None;
    let mut episode = None;
    let mut episode_end = None;
    let mut version = None;
    let mut name_part = s.clone();
    let mut title_part = String::new();
    let mut strong = false;

    if let Some(m) = find_episode(&s) {
        season = m.season;
        episode = Some(m.episode);
        episode_end = m.episode_end.filter(|e| *e > m.episode && *e - m.episode <= 3);
        version = m.version;
        strong = m.strong;
        name_part = s[..m.start].to_string();
        title_part = s[m.end..].to_string();
        if m.start == 0 {
            // "02 - Titel.mp4": nach der Nummer folgt ggf. der Episodentitel
            if let Some(c) = LEADING_NUM.captures(&s) {
                title_part = c.get(3).map(|x| x.as_str().to_string()).unwrap_or_default();
            }
        }
    }

    // Specials / OVA / Filme
    if let Some(c) = SPECIAL_WORD.captures(&s) {
        let word = c[1].to_lowercase();
        let detected = match word.as_str() {
            "ova" | "oad" | "ona" => Some(EpisodeKind::Ova),
            "special" | "specials" | "sp" | "recap" => Some(EpisodeKind::Special),
            "movie" | "film" | "the movie" | "gekijouban" => Some(EpisodeKind::Movie),
            _ => Some(EpisodeKind::Extra),
        };
        // "sp" nur zählen, wenn eine Nummer folgt (sonst zu viele Fehltreffer)
        let accept = word != "sp" || c.get(2).is_some();
        if accept {
            kind = detected.unwrap();
            let m = c.get(0).unwrap();
            if episode.is_none() || (m.start() <= name_part.len() && c.get(2).is_some()) {
                if let Some(n) = num(&c, 2) {
                    episode = Some(n);
                }
                if m.start() < name_part.len() {
                    title_part = format!("{} {}", &name_part[m.end().min(name_part.len())..], title_part);
                    name_part = name_part[..m.start()].to_string();
                }
            } else if m.start() < name_part.len() {
                name_part = name_part[..m.start()].to_string();
            }
        }
    }
    if kind == EpisodeKind::Episode {
        if let Some(k) = folder_kind {
            kind = k;
        }
    }

    let (mut series_name, name_season) = clean_series_name(&name_part, &mut tags);
    if season.is_none() {
        season = name_season;
    }
    if season.is_none() {
        season = folder_season;
    }
    // Ziffern- oder Kürzel-Reste ("S1", "Ep") sind kein Serienname
    if !series_name.chars().filter(|c| c.is_alphabetic()).nth(1).is_some() {
        series_name.clear();
    }

    let mut episode_title = clean_episode_title(&title_part);
    let mut name_source = NameSource::Filename;
    let mut alt_title = tags.alt_title.clone();

    if series_name.is_empty() {
        if let Some(f) = folder_name.clone() {
            series_name = f;
            name_source = NameSource::Folder;
        } else {
            name_source = NameSource::None;
        }
    } else if let Some(f) = &folder_name {
        // Ordnername bevorzugen, wenn der Dateiname nur eine Abkürzung/Variante davon ist
        if normalize_title(f) != normalize_title(&series_name) && alt_title.is_none() && normalize_title(f).contains(&normalize_title(&series_name)) {
            alt_title = Some(series_name.clone());
            series_name = f.clone();
        }
    }

    // Kein Episodenmarker, aber ein Name: Film oder Einzeldatei
    if episode.is_none() && !series_name.is_empty() && name_source == NameSource::Filename {
        if kind == EpisodeKind::Episode {
            kind = EpisodeKind::Movie;
        }
        if episode_title.is_none() && name_source == NameSource::Filename {
            episode_title = None;
        }
    }

    let mut confidence: f32 = match (name_source, episode.is_some()) {
        (NameSource::Filename, true) => {
            if strong { 0.95 } else { 0.7 }
        }
        (NameSource::Folder, true) => 0.85,
        (NameSource::Filename, false) => 0.65,
        (NameSource::Folder, false) => {
            if kind != EpisodeKind::Episode { 0.7 } else { 0.45 }
        }
        (NameSource::None, _) => 0.1,
    };
    if series_name.chars().count() < 2 {
        confidence = confidence.min(0.2);
    }

    ParsedFile {
        series_title: if series_name.is_empty() { None } else { Some(series_name) },
        alt_title,
        name_source,
        season,
        episode,
        episode_end,
        episode_title,
        kind,
        resolution: tags.resolution,
        audio_hints: tags.audio,
        subtitle_hints: tags.subs,
        version,
        year: tags.year,
        confidence,
    }
}

/// Normalisierte Form eines Titels für Vergleiche (Kleinbuchstaben, nur alphanumerisch).
pub fn normalize_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for ch in s.chars() {
        let ch = match ch {
            'ä' | 'Ä' => 'a',
            'ö' | 'Ö' => 'o',
            'ü' | 'Ü' => 'u',
            'ß' => 's',
            'ō' | 'Ō' => 'o',
            'ū' | 'Ū' => 'u',
            c => c,
        };
        if ch.is_alphanumeric() {
            for l in ch.to_lowercase() {
                out.push(l);
            }
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p(file: &str) -> ParsedFile {
        parse_path(&PathBuf::from(format!("D:\\Anime\\{file}")), Some(Path::new("D:\\Anime")))
    }

    #[test]
    fn sxxexx() {
        let r = p("Naruto S01E02.mp4");
        assert_eq!(r.series_title.as_deref(), Some("Naruto"));
        assert_eq!((r.season, r.episode), (Some(1), Some(2)));
        assert!(r.confidence >= AUTO_ASSIGN_THRESHOLD);
    }

    #[test]
    fn dash_absolute() {
        let r = p("One Piece - 1025.mp4");
        assert_eq!(r.series_title.as_deref(), Some("One Piece"));
        assert_eq!(r.episode, Some(1025));
        assert_eq!(r.season, None);
    }

    #[test]
    fn german_words() {
        let r = p("Attack on Titan Staffel 2 Folge 4.mp4");
        assert_eq!(r.series_title.as_deref(), Some("Attack on Titan"));
        assert_eq!((r.season, r.episode), (Some(2), Some(4)));
    }

    #[test]
    fn trailing_number() {
        let r = p("Demon Slayer 03.mp4");
        assert_eq!(r.series_title.as_deref(), Some("Demon Slayer"));
        assert_eq!(r.episode, Some(3));
    }

    #[test]
    fn resolution_not_episode() {
        let r = p("Anime_Name - 01 [1080p].mp4");
        assert_eq!(r.series_title.as_deref(), Some("Anime Name"));
        assert_eq!(r.episode, Some(1));
        assert_eq!(r.resolution.as_deref(), Some("1080p"));
        let r = p("Naruto 1080p 05.mkv");
        assert_eq!(r.episode, Some(5));
        assert_eq!(r.resolution.as_deref(), Some("1080p"));
    }

    #[test]
    fn bare_files_are_unsorted_in_root() {
        let r = p("S1 Ep2.mp4");
        assert_eq!(r.series_title, None);
        assert_eq!((r.season, r.episode), (Some(1), Some(2)));
        assert!(r.confidence < AUTO_ASSIGN_THRESHOLD);
        let r = p("02.mp4");
        assert_eq!(r.series_title, None);
        assert_eq!(r.episode, Some(2));
        assert!(r.confidence < AUTO_ASSIGN_THRESHOLD);
        let r = p("Episode_003.mp4");
        assert_eq!(r.series_title, None);
        assert_eq!(r.episode, Some(3));
        assert!(r.confidence < AUTO_ASSIGN_THRESHOLD);
    }

    #[test]
    fn bare_files_use_folder() {
        let r = parse_path(Path::new("D:\\Anime\\Naruto\\Staffel 2\\S1 Ep2.mp4"), Some(Path::new("D:\\Anime")));
        assert_eq!(r.series_title.as_deref(), Some("Naruto"));
        assert_eq!((r.season, r.episode), (Some(1), Some(2)));
        assert!(r.confidence >= AUTO_ASSIGN_THRESHOLD);
        let r = parse_path(Path::new("E:\\Serien\\[SubsPlease] Frieren (1080p)\\02.mp4"), Some(Path::new("E:\\Serien")));
        assert_eq!(r.series_title.as_deref(), Some("Frieren"));
        assert_eq!(r.episode, Some(2));
        let r = parse_path(Path::new("E:\\Serien\\Bleach\\Season 03\\Episode_003.mp4"), Some(Path::new("E:\\Serien")));
        assert_eq!(r.series_title.as_deref(), Some("Bleach"));
        assert_eq!((r.season, r.episode), (Some(3), Some(3)));
    }

    #[test]
    fn fansub_style() {
        let r = p("[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv");
        assert_eq!(r.series_title.as_deref(), Some("Sousou no Frieren"));
        assert_eq!(r.episode, Some(12));
        assert_eq!(r.resolution.as_deref(), Some("1080p"));
        let r = p("[Erai-raws] Shingeki no Kyojin Season 2 - 04 [720p][Multiple Subtitle].mkv");
        assert_eq!(r.series_title.as_deref(), Some("Shingeki no Kyojin"));
        assert_eq!((r.season, r.episode), (Some(2), Some(4)));
    }

    #[test]
    fn dotted_names_and_titles() {
        let r = p("Naruto.Shippuden.S02E15.The.Fourth.Hokage.1080p.WEB-DL.x264.mkv");
        assert_eq!(r.series_title.as_deref(), Some("Naruto Shippuden"));
        assert_eq!((r.season, r.episode), (Some(2), Some(15)));
        assert_eq!(r.episode_title.as_deref(), Some("The Fourth Hokage"));
    }

    #[test]
    fn hints_and_versions() {
        let r = p("Jujutsu Kaisen - 05v2 [GerSub] [1080p].mp4");
        assert_eq!(r.episode, Some(5));
        assert_eq!(r.version, Some(2));
        assert!(r.subtitle_hints.iter().any(|h| h.contains("Deutsch")));
        let r = p("Spy x Family 07 GerDub.mp4");
        assert_eq!(r.series_title.as_deref(), Some("Spy x Family"));
        assert_eq!(r.episode, Some(7));
        assert!(r.audio_hints.iter().any(|h| h.contains("Deutsch")));
    }

    #[test]
    fn specials_and_movies() {
        let r = p("Attack on Titan OVA 3.mp4");
        assert_eq!(r.kind, EpisodeKind::Ova);
        assert_eq!(r.episode, Some(3));
        assert_eq!(r.series_title.as_deref(), Some("Attack on Titan"));
        let r = parse_path(Path::new("D:\\Anime\\Naruto\\Specials\\Naruto - 01.mkv"), Some(Path::new("D:\\Anime")));
        assert_eq!(r.kind, EpisodeKind::Special);
        let r = p("Your Name (2016).mp4");
        assert_eq!(r.series_title.as_deref(), Some("Your Name"));
        assert_eq!(r.kind, EpisodeKind::Movie);
        assert_eq!(r.year, Some(2016));
    }

    #[test]
    fn multi_part() {
        let r = p("Bleach S01E01-E02.mkv");
        assert_eq!((r.episode, r.episode_end), (Some(1), Some(2)));
    }

    #[test]
    fn season_suffix_in_name() {
        let r = p("Demon Slayer 2nd Season 03.mp4");
        assert_eq!(r.series_title.as_deref(), Some("Demon Slayer"));
        assert_eq!((r.season, r.episode), (Some(2), Some(3)));
        let r = p("1x05 - Something.mp4");
        assert_eq!((r.season, r.episode), (Some(1), Some(5)));
    }

    #[test]
    fn number_before_ep_word() {
        let r = parse_path(Path::new("D:\\Anime\\Call of the Night\\10ep.mp4"), Some(Path::new("D:\\Anime")));
        assert_eq!(r.series_title.as_deref(), Some("Call of the Night"));
        assert_eq!(r.episode, Some(10));
        assert_eq!(r.kind, EpisodeKind::Episode);
        assert!(r.confidence >= AUTO_ASSIGN_THRESHOLD);
        let r = p("2ep.mp4");
        assert_eq!((r.series_title.as_deref(), r.episode), (None, Some(2)));
        assert!(r.confidence < AUTO_ASSIGN_THRESHOLD);
        let r = p("Naruto 5. Folge.mp4");
        assert_eq!((r.series_title.as_deref(), r.episode), (Some("Naruto"), Some(5)));
        let r = p("Bleach 12 ep.mkv");
        assert_eq!((r.series_title.as_deref(), r.episode), (Some("Bleach"), Some(12)));
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_title("Attack on Titan: Final Season!"), "attack on titan final season");
        assert_eq!(normalize_title("Shingeki no Kyōjin"), "shingeki no kyojin");
    }
}
