use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::settings::Settings;

pub struct AppState {
    /// Ordner für Cover, Vorschaubilder, Untertitel-Cache, Protokolle und Backups.
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub conn: Mutex<Connection>,
    pub scanning: Arc<AtomicBool>,
    pub scan_cancel: Arc<AtomicBool>,
    pub metadata_running: Arc<AtomicBool>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub watch_dirty: Arc<Mutex<Option<std::time::Instant>>>,
    pub last_scan_progress: Mutex<Option<crate::scanner::ScanProgress>>,
}

impl AppState {
    pub fn db(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| AppError::msg("Datenbank ist blockiert"))
    }

    pub fn settings(&self) -> AppResult<Settings> {
        crate::settings::load(&*self.db()?)
    }

    pub fn is_scanning(&self) -> bool {
        self.scanning.load(Ordering::SeqCst)
    }

    pub fn images_dir(&self) -> PathBuf {
        self.data_dir.join("images")
    }
    pub fn thumbs_dir(&self) -> PathBuf {
        self.data_dir.join("thumbs")
    }
    pub fn subs_dir(&self) -> PathBuf {
        self.data_dir.join("subtitles")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }
}
