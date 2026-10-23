//! Optionale Hintergrundüberwachung der Quellordner und zeitgesteuerter Scan.

use notify::{RecursiveMode, Watcher};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// (Re-)Startet die Ordnerüberwachung gemäß den aktuellen Einstellungen.
pub fn configure(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings().unwrap_or_default();
    let mut guard = match state.watcher.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    *guard = None;
    if !settings.watch_folders {
        return;
    }
    let dirty = state.watch_dirty.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let relevant = ev.paths.iter().any(|p| crate::parser::is_video_file(p) || p.extension().is_none());
            if relevant && !matches!(ev.kind, notify::EventKind::Access(_)) {
                if let Ok(mut d) = dirty.lock() {
                    *d = Some(Instant::now());
                }
            }
        }
    });
    let mut watcher = match watcher {
        Ok(w) => w,
        Err(e) => {
            log::error!("Ordnerüberwachung konnte nicht gestartet werden: {e}");
            return;
        }
    };
    let sources = state
        .db()
        .ok()
        .and_then(|c| crate::db::list_sources(&c).ok())
        .unwrap_or_default();
    for s in sources.iter().filter(|s| s.enabled) {
        let p = Path::new(&s.path);
        if p.is_dir() {
            if let Err(e) = watcher.watch(p, RecursiveMode::Recursive) {
                log::warn!("Überwachung von {} nicht möglich: {e}", s.path);
            }
        }
    }
    log::info!("Ordnerüberwachung aktiv für {} Ordner", sources.len());
    *guard = Some(watcher);
}

/// Hintergrund-Thread: löst nach Dateiänderungen (entprellt) bzw. im eingestellten Intervall einen Scan aus.
pub fn spawn_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_interval_scan = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let state = app.state::<AppState>();
            let pending = state.watch_dirty.lock().ok().and_then(|d| *d);
            if let Some(t) = pending {
                if t.elapsed() > Duration::from_secs(6) && !state.is_scanning() {
                    if let Ok(mut d) = state.watch_dirty.lock() {
                        *d = None;
                    }
                    log::info!("Änderungen in Quellordnern erkannt – starte Scan");
                    let _ = crate::scanner::start_scan(&app, None, "watch");
                }
            }
            let interval = state.settings().map(|s| s.scan_interval_minutes).unwrap_or(0);
            if interval > 0 && last_interval_scan.elapsed() > Duration::from_secs(interval as u64 * 60) {
                last_interval_scan = Instant::now();
                if !state.is_scanning() {
                    log::info!("Geplanter Scan ({interval} min)");
                    let _ = crate::scanner::start_scan(&app, None, "interval");
                }
            }
        }
    });
}
