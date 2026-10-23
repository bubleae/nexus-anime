//! Plugin-System.
//!
//! Plugins sind Ordner unter `<Datenordner>\plugins\<id>` mit einer `manifest.json` und einer
//! JavaScript-Datei (Standard: `main.js`). Ausgeführt werden sie in der Oberfläche; das Backend
//! liefert Dateien, speichert Zustand und Plugin-Daten und stellt Fähigkeiten bereit, die im
//! WebView nicht möglich sind (HTTP ohne CORS, Dateisystem, Programme starten, SQL).
//!
//! Python-Plugins (`main.py`) laufen als eigener Prozess mit dem installierten Python. Sie sprechen
//! über JSON-Zeilen auf stdin/stdout mit der Oberfläche; das Modul `nexus` (python/nexus.py) kapselt das.
//!
//! Plugins haben bewusst vollen Zugriff – installiere nur Plugins, denen du vertraust.

use rusqlite::types::ValueRef;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write as _};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

type Cmd<T> = Result<T, AppError>;

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plugin_data(
           plugin_id TEXT NOT NULL,
           key TEXT NOT NULL,
           value TEXT NOT NULL,
           PRIMARY KEY(plugin_id, key)
         );",
    )?;
    Ok(())
}

fn plugins_dir(state: &AppState) -> AppResult<PathBuf> {
    let dir = state.data_dir.join("plugins");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Erlaubt nur einfache IDs (werden als Ordnername verwendet).
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') && !id.starts_with('.')
}

fn slug(name: &str) -> String {
    let mut s: String = name
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'ä' => 'a',
            'ö' => 'o',
            'ü' => 'u',
            'ß' => 's',
            c if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "plugin".into() } else { s.chars().take(48).collect() }
}

/// Löst einen relativen Pfad innerhalb des Plugin-Ordners auf (kein Ausbrechen per `..`).
fn plugin_file(state: &AppState, id: &str, rel: &str) -> AppResult<PathBuf> {
    if !valid_id(id) {
        return Err(AppError::msg("Ungültige Plugin-ID"));
    }
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(AppError::msg("Ungültiger Dateipfad im Plugin"));
    }
    Ok(plugins_dir(state)?.join(id).join(rel))
}

// ---------------------------------------------------------------------------
// Aktivierungszustand
// ---------------------------------------------------------------------------

fn load_states(conn: &Connection) -> AppResult<BTreeMap<String, bool>> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = 'plugins'", [], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default())
}

fn save_states(conn: &Connection, s: &BTreeMap<String, bool>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES('plugins', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![serde_json::to_string(s)?],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Verwaltung
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    id: String,
    dir: String,
    manifest: Value,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOverview {
    dir: String,
    plugins: Vec<PluginInfo>,
    /// Gespeicherter Zustand je Plugin-ID (auch für eingebaute Plugins). Fehlt ein Eintrag, gilt `defaultEnabled`.
    states: BTreeMap<String, bool>,
}

fn read_manifest(dir: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(dir.join("manifest.json")).map_err(|_| "manifest.json fehlt oder ist nicht lesbar".to_string())?;
    let v: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|e| format!("manifest.json ist ungültig: {e}"))?;
    if !v.is_object() {
        return Err("manifest.json muss ein Objekt sein".into());
    }
    Ok(v)
}

#[tauri::command(async)]
pub fn plugin_list(state: State<AppState>) -> Cmd<PluginOverview> {
    let dir = plugins_dir(&state)?;
    let mut plugins = vec![];
    let mut entries: Vec<_> = std::fs::read_dir(&dir)?.flatten().filter(|e| e.path().is_dir()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let folder = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        let (manifest, mut error) = match read_manifest(&path) {
            Ok(m) => (m, None),
            Err(err) => (json!({ "name": folder }), Some(err)),
        };
        // Die ID ist immer der Ordnername – so bleiben Speicher und Zustand eindeutig.
        if let Some(mid) = manifest.get("id").and_then(|v| v.as_str()) {
            if mid != folder && error.is_none() {
                log::warn!("Plugin-Ordner {folder}: manifest-ID {mid} weicht ab, Ordnername wird verwendet");
            }
        }
        if !valid_id(&folder) && error.is_none() {
            error = Some("Ordnername ist als Plugin-ID ungültig (erlaubt: a–z, 0–9, - _ .)".into());
        }
        plugins.push(PluginInfo { id: folder, dir: path.to_string_lossy().to_string(), manifest, error });
    }
    let states = load_states(&*state.db()?)?;
    Ok(PluginOverview { dir: dir.to_string_lossy().to_string(), plugins, states })
}

#[tauri::command(async)]
pub fn plugin_set_enabled(state: State<AppState>, id: String, enabled: bool) -> Cmd<()> {
    let conn = state.db()?;
    let mut s = load_states(&conn)?;
    s.insert(id.clone(), enabled);
    save_states(&conn, &s)?;
    log::info!("Plugin {id} {}", if enabled { "aktiviert" } else { "deaktiviert" });
    Ok(())
}

#[tauri::command(async)]
pub fn plugin_read_file(state: State<AppState>, id: String, path: String) -> Cmd<String> {
    let p = plugin_file(&state, &id, &path)?;
    std::fs::read_to_string(&p).map_err(|e| AppError::msg(format!("{path}: {}", AppError::from(e))))
}

fn copy_dir(from: &Path, to: &Path) -> AppResult<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            if e.file_name() == "node_modules" || e.file_name() == ".git" {
                continue;
            }
            copy_dir(&e.path(), &target)?;
        } else {
            std::fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

/// Installiert ein Plugin aus einem Ordner (mit manifest.json) oder aus einer einzelnen .js-Datei.
/// Ein vorhandenes Plugin gleicher ID wird ersetzt (alte Version wandert in den Papierkorb).
#[tauri::command(async)]
pub fn plugin_install(state: State<AppState>, path: String) -> Cmd<String> {
    let src = PathBuf::from(&path);
    let root = plugins_dir(&state)?;
    if src.is_dir() {
        let manifest = read_manifest(&src).map_err(AppError::msg)?;
        let id = manifest
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| slug(manifest.get("name").and_then(|v| v.as_str()).unwrap_or("plugin")));
        if !valid_id(&id) {
            return Err(AppError::msg(format!("Ungültige Plugin-ID „{id}“ (erlaubt: a–z, 0–9, - _ .)")));
        }
        let target = root.join(&id);
        if src.canonicalize().ok() == target.canonicalize().ok() {
            return Ok(id);
        }
        stop_python(&id);
        if target.exists() {
            trash::delete(&target)?;
        }
        copy_dir(&src, &target)?;
        log::info!("Plugin {id} installiert aus {path}");
        Ok(id)
    } else if let Some(main) = src.extension().and_then(|e| e.to_str()).and_then(|e| match e.to_ascii_lowercase().as_str() {
        "js" | "mjs" => Some("main.js"),
        "py" => Some("main.py"),
        _ => None,
    }) {
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("plugin").to_string();
        let id = slug(&stem);
        let target = root.join(&id);
        stop_python(&id);
        if target.exists() {
            trash::delete(&target)?;
        }
        std::fs::create_dir_all(&target)?;
        std::fs::copy(&src, target.join(main))?;
        let manifest = json!({ "id": id, "name": stem, "version": "1.0.0", "main": main, "description": "" });
        std::fs::write(target.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;
        log::info!("Plugin {id} installiert aus Datei {path}");
        Ok(id)
    } else {
        Err(AppError::msg("Bitte einen Plugin-Ordner (mit manifest.json), eine .js- oder eine .py-Datei wählen"))
    }
}

#[tauri::command(async)]
pub fn plugin_uninstall(state: State<AppState>, id: String) -> Cmd<()> {
    if !valid_id(&id) {
        return Err(AppError::msg("Ungültige Plugin-ID"));
    }
    stop_python(&id);
    let dir = plugins_dir(&state)?.join(&id);
    if dir.exists() {
        trash::delete(&dir)?;
    }
    let conn = state.db()?;
    conn.execute("DELETE FROM plugin_data WHERE plugin_id = ?1", params![id])?;
    let mut s = load_states(&conn)?;
    s.remove(&id);
    save_states(&conn, &s)?;
    log::info!("Plugin {id} entfernt (Ordner im Papierkorb)");
    Ok(())
}

const TEMPLATE_JS: &str = r#"// Neues NEXUS-ANIME-Plugin. Dokumentation: Einstellungen → Plugins → „Anleitung“.
// Nach Änderungen: Einstellungen → Plugins → „Neu laden“.

export default function activate(nexus) {
  const { h } = nexus;

  // 1) Eine eigene Seite (erscheint im Menü „Mehr“)
  nexus.ui.addPage({
    id: "main",
    title: "__NAME__",
    render: () =>
      h("div", { className: "page" },
        h("h1", { className: "page-title" }, "__NAME__"),
        h("p", { className: "hint" }, `Deine Bibliothek enthält ${nexus.library.series().length} Serien.`),
        h("button", { className: "btn primary", onClick: () => nexus.ui.toast("success", "Hallo aus __NAME__!") }, "Klick mich"),
      ),
  });

  // 2) Ein Eintrag im Episoden-Menü (Rechtsklick auf eine Folge)
  nexus.ui.addEpisodeMenuItem({
    label: "Dateinamen anzeigen",
    onClick: (episode) => nexus.ui.toast("info", episode.fileName),
  });

  // 3) Auf Ereignisse reagieren
  nexus.events.on("episode:watched", ({ episode }) => {
    nexus.log("info", `Fertig angesehen: ${episode.fileName}`);
  });

  // Optional: Aufräumfunktion beim Deaktivieren
  return () => {};
}
"#;

const TEMPLATE_PY: &str = r#"# Neues NEXUS-ANIME-Plugin in Python. Dokumentation: Einstellungen → Plugins → „Anleitung & API“.
# Nach Änderungen: Einstellungen → Plugins → „Neu laden“. print() landet im Protokoll.
import nexus

# 1) Eine eigene Seite (erscheint im Menü „Mehr“). Die Funktion liefert HTML;
#    Elemente mit data-action rufen die passende Funktion aus `actions` auf.
klicks = 0


def seite(ctx):
    anzahl = len(nexus.library.series())
    return f"""
      <div class="page">
        <h1 class="page-title">__NAME__</h1>
        <p class="hint">Deine Bibliothek enthält {anzahl} Serien. Geklickt: {klicks}</p>
        <button class="btn primary" data-action="klick">Klick mich</button>
      </div>"""


def klick(data):
    global klicks
    klicks += 1
    nexus.ui.toast("success", "Hallo aus Python!")


nexus.ui.add_page(id="main", title="__NAME__", icon="🐍", html=seite, actions={"klick": klick})


# 2) Ein Eintrag im Episoden-Menü (Rechtsklick auf eine Folge)
def dateiname(episode):
    nexus.ui.toast("info", episode.file_name)


nexus.ui.add_episode_menu_item(label="Dateinamen anzeigen (Python)", on_click=dateiname)


# 3) Auf Ereignisse reagieren
@nexus.on("episode:watched")
def angesehen(data):
    print("Fertig angesehen:", data.episode.file_name)
"#;

/// Legt ein neues Plugin aus einer Vorlage an und gibt seine ID zurück. `lang`: "js" (Standard) oder "py".
#[tauri::command(async)]
pub fn plugin_create(state: State<AppState>, name: String, lang: Option<String>) -> Cmd<String> {
    let python = lang.as_deref() == Some("py");
    let name = name.trim();
    let name = if name.is_empty() { "Mein Plugin" } else { name };
    let root = plugins_dir(&state)?;
    let base = slug(name);
    let mut id = base.clone();
    let mut n = 2;
    while root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir)?;
    let manifest = json!({
        "id": id,
        "name": name,
        "version": "1.0.0",
        "description": "Eigenes Plugin",
        "author": "",
        "main": if python { "main.py" } else { "main.js" },
        "styles": [],
    });
    std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;
    let safe = name.replace('"', "'").replace('`', "'");
    if python {
        std::fs::write(dir.join("main.py"), TEMPLATE_PY.replace("__NAME__", &safe))?;
    } else {
        std::fs::write(dir.join("main.js"), TEMPLATE_JS.replace("__NAME__", &safe))?;
    }
    // Neue Plugins sind sofort aktiv
    let conn = state.db()?;
    let mut s = load_states(&conn)?;
    s.insert(id.clone(), true);
    save_states(&conn, &s)?;
    log::info!("Plugin {id} aus Vorlage erstellt");
    Ok(id)
}

// ---------------------------------------------------------------------------
// Plugin-Speicher (Schlüssel/Wert, JSON)
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn plugin_storage_get(state: State<AppState>, id: String) -> Cmd<Map<String, Value>> {
    let conn = state.db()?;
    let mut stmt = conn.prepare("SELECT key, value FROM plugin_data WHERE plugin_id = ?1")?;
    let rows = stmt.query_map(params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Map::new();
    for row in rows.flatten() {
        out.insert(row.0, serde_json::from_str(&row.1).unwrap_or(Value::Null));
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn plugin_storage_set(state: State<AppState>, id: String, key: String, value: Option<Value>) -> Cmd<()> {
    let conn = state.db()?;
    match value {
        Some(v) if !v.is_null() => {
            conn.execute(
                "INSERT INTO plugin_data(plugin_id, key, value) VALUES(?1, ?2, ?3)
                 ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
                params![id, key, serde_json::to_string(&v)?],
            )?;
        }
        _ => {
            conn.execute("DELETE FROM plugin_data WHERE plugin_id = ?1 AND key = ?2", params![id, key])?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Fähigkeiten: HTTP, Dateisystem, Programme, SQL
// ---------------------------------------------------------------------------

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(concat!("NexusAnime/", env!("CARGO_PKG_VERSION"), " (Plugin)"))
        .build()
        .expect("HTTP-Client")
});

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

#[tauri::command]
pub async fn plugin_http(req: HttpRequest) -> Cmd<HttpResponse> {
    let method = reqwest::Method::from_bytes(req.method.as_deref().unwrap_or("GET").to_uppercase().as_bytes())
        .map_err(|_| AppError::msg("Ungültige HTTP-Methode"))?;
    let mut b = CLIENT.request(method, &req.url).timeout(Duration::from_millis(req.timeout_ms.unwrap_or(30_000)));
    for (k, v) in &req.headers {
        b = b.header(k, v);
    }
    if let Some(body) = req.body {
        b = b.body(body);
    }
    let res = b.send().await?;
    let status = res.status().as_u16();
    let headers = res.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let body = res.text().await?;
    Ok(HttpResponse { status, headers, body })
}

#[tauri::command(async)]
pub fn plugin_fs_read(path: String) -> Cmd<String> {
    Ok(std::fs::read_to_string(path)?)
}

#[tauri::command(async)]
pub fn plugin_fs_write(path: String, content: String, append: Option<bool>) -> Cmd<()> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if append.unwrap_or(false) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p)?;
        f.write_all(content.as_bytes())?;
    } else {
        std::fs::write(p, content)?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[tauri::command(async)]
pub fn plugin_fs_list(path: String) -> Cmd<Vec<DirEntry>> {
    let mut out = vec![];
    for e in std::fs::read_dir(&path)?.flatten() {
        let meta = e.metadata().ok();
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            path: e.path().to_string_lossy().to_string(),
            is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command(async)]
pub fn plugin_fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[derive(Serialize)]
pub struct RunResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Startet ein Programm (ohne Shell). Mit `wait = false` läuft es losgelöst weiter.
#[tauri::command(async)]
pub fn plugin_run(program: String, args: Vec<String>, cwd: Option<String>, wait: Option<bool>) -> Cmd<RunResult> {
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if wait.unwrap_or(true) {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    log::info!("Plugin startet Programm: {program} {args:?}");
    if wait.unwrap_or(true) {
        let out = cmd.output().map_err(|e| AppError::msg(format!("„{program}“ konnte nicht gestartet werden: {}", AppError::from(e))))?;
        Ok(RunResult {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        })
    } else {
        cmd.spawn().map_err(|e| AppError::msg(format!("„{program}“ konnte nicht gestartet werden: {}", AppError::from(e))))?;
        Ok(RunResult { code: None, stdout: String::new(), stderr: String::new() })
    }
}

fn json_to_sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(V::Integer).unwrap_or_else(|| V::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => V::Text(s.clone()),
        other => V::Text(other.to_string()),
    }
}

/// Führt SQL auf der Bibliotheksdatenbank aus. Abfragen liefern Zeilen als Objekte,
/// andere Anweisungen `{ "changes": n }`.
#[tauri::command(async)]
pub fn plugin_sql(state: State<AppState>, sql: String, params: Option<Vec<Value>>) -> Cmd<Value> {
    let conn = state.db()?;
    let p: Vec<_> = params.unwrap_or_default().iter().map(json_to_sql).collect();
    let mut stmt = conn.prepare(&sql)?;
    if stmt.column_count() == 0 {
        let n = stmt.execute(params_from_iter(p))?;
        return Ok(json!({ "changes": n }));
    }
    let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(params_from_iter(p))?;
    let mut out = vec![];
    while let Some(r) = rows.next()? {
        let mut obj = Map::new();
        for (i, c) in cols.iter().enumerate() {
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
                ValueRef::Blob(b) => json!(b.len()),
            };
            obj.insert(c.clone(), v);
        }
        out.push(Value::Object(obj));
    }
    Ok(Value::Array(out))
}

// ---------------------------------------------------------------------------
// Python-Plugins
// ---------------------------------------------------------------------------

/// Laufzeitmodul `nexus` für Python-Plugins.
const PY_RUNTIME: &str = include_str!("../python/nexus.py");

struct PyProc {
    child: Child,
    stdin: ChildStdin,
}

static PY_PROCS: LazyLock<Mutex<HashMap<String, PyProc>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static PY_CMD: LazyLock<Mutex<Option<Vec<String>>>> = LazyLock::new(|| Mutex::new(None));

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

/// Sucht ein Python-3-Programm. Ein Erfolg wird gemerkt, ein Fehlschlag nicht (Python kann nachinstalliert werden).
fn find_python(custom: Option<&str>) -> AppResult<Vec<String>> {
    let mut candidates: Vec<Vec<String>> = vec![];
    if let Some(c) = custom.filter(|c| !c.trim().is_empty()) {
        candidates.push(vec![c.to_string()]);
    } else {
        if let Some(c) = PY_CMD.lock().ok().and_then(|g| g.clone()) {
            return Ok(c);
        }
        candidates.extend([vec!["python".into()], vec!["py".into(), "-3".into()], vec!["python3".into()]]);
    }
    for c in candidates {
        let mut cmd = Command::new(&c[0]);
        cmd.args(&c[1..]).arg("--version").stdin(Stdio::null());
        hide_window(&mut cmd);
        if let Ok(out) = cmd.output() {
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            if out.status.success() && text.contains("Python 3") {
                if custom.is_none() {
                    if let Ok(mut g) = PY_CMD.lock() {
                        *g = Some(c.clone());
                    }
                }
                return Ok(c);
            }
        }
    }
    Err(AppError::msg(
        "Python 3 wurde nicht gefunden. Installiere Python von python.org (Option „Add python.exe to PATH“) oder gib im Manifest unter \"python\" den Pfad zu python.exe an.",
    ))
}

pub fn stop_python(id: &str) {
    if let Some(mut p) = PY_PROCS.lock().ok().and_then(|mut g| g.remove(id)) {
        let _ = p.child.kill();
        let _ = p.child.wait();
        log::info!("Python-Plugin {id} beendet");
    }
}

/// Beendet alle Python-Plugins (beim Schließen der App).
pub fn stop_all_python() {
    let ids: Vec<String> = PY_PROCS.lock().map(|g| g.keys().cloned().collect()).unwrap_or_default();
    for id in ids {
        stop_python(&id);
    }
}

#[derive(Serialize, Clone)]
struct PyMessage {
    id: String,
    line: Option<String>,
    stderr: Option<String>,
    exit: Option<i32>,
}

/// Startet ein Python-Plugin. Nachrichten kommen als Ereignis `plugin-py://message` an.
#[tauri::command(async)]
pub fn plugin_py_start(app: AppHandle, state: State<AppState>, id: String, main: String, python: Option<String>) -> Cmd<String> {
    stop_python(&id);
    let script = plugin_file(&state, &id, &main)?;
    if !script.is_file() {
        return Err(AppError::msg(format!("{main} fehlt im Plugin-Ordner")));
    }
    let dir = plugins_dir(&state)?.join(&id);
    let runtime_dir = state.data_dir.join("python");
    std::fs::create_dir_all(&runtime_dir)?;
    std::fs::write(runtime_dir.join("nexus.py"), PY_RUNTIME)?;
    let py = find_python(python.as_deref())?;

    let mut cmd = Command::new(&py[0]);
    cmd.args(&py[1..])
        .args(["-u", "-X", "utf8", "-c", "import sys, nexus; nexus._main(sys.argv[1])"])
        .arg(&script)
        .current_dir(&dir)
        .env("PYTHONPATH", &runtime_dir)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("NEXUS_PLUGIN_ID", &id)
        .env("NEXUS_DATA_DIR", &state.data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| AppError::msg(format!("Python konnte nicht gestartet werden: {}", AppError::from(e))))?;
    let stdin = child.stdin.take().ok_or_else(|| AppError::msg("Python: keine Eingabe"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("Python: keine Ausgabe"))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::msg("Python: keine Fehlerausgabe"))?;
    let pid = child.id();
    PY_PROCS.lock().map_err(|_| AppError::msg("Plugin-Verwaltung blockiert"))?.insert(id.clone(), PyProc { child, stdin });

    {
        let (app, id) = (app.clone(), id.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app.emit("plugin-py://message", PyMessage { id: id.clone(), line: Some(line), stderr: None, exit: None });
            }
            // Ausgabe beendet → Prozess ist vorbei. Nur melden, wenn er nicht absichtlich beendet wurde.
            let code = PY_PROCS.lock().ok().and_then(|mut g| match g.get_mut(&id) {
                Some(p) if p.child.id() == pid => {
                    let c = p.child.wait().ok().and_then(|s| s.code());
                    g.remove(&id);
                    Some(c.unwrap_or(-1))
                }
                _ => None,
            });
            if let Some(code) = code {
                log::warn!("Python-Plugin {id} hat sich beendet (Code {code})");
                let _ = app.emit("plugin-py://message", PyMessage { id, line: None, stderr: None, exit: Some(code) });
            }
        });
    }
    {
        let (app, id) = (app.clone(), id.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[Plugin {id}] {line}");
                let _ = app.emit("plugin-py://message", PyMessage { id: id.clone(), line: None, stderr: Some(line), exit: None });
            }
        });
    }
    log::info!("Python-Plugin {id} gestartet ({})", py.join(" "));
    Ok(py.join(" "))
}

#[tauri::command(async)]
pub fn plugin_py_send(id: String, line: String) -> Cmd<()> {
    let mut g = PY_PROCS.lock().map_err(|_| AppError::msg("Plugin-Verwaltung blockiert"))?;
    let p = g.get_mut(&id).ok_or_else(|| AppError::msg("Das Python-Plugin läuft nicht"))?;
    p.stdin.write_all(line.as_bytes())?;
    p.stdin.write_all(b"\n")?;
    p.stdin.flush()?;
    Ok(())
}

#[tauri::command(async)]
pub fn plugin_py_stop(id: String) {
    stop_python(&id);
}
