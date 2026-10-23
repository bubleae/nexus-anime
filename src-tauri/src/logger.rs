//! Einfaches Datei-Protokoll im Datenordner (logs/nexus.log), max. ~5 MB.

use log::{Level, LevelFilter, Metadata, Record};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

struct FileLogger {
    file: Mutex<Option<File>>,
}

impl log::Log for FileLogger {
    fn enabled(&self, m: &Metadata) -> bool {
        m.level() <= Level::Info || m.target().starts_with("nexus")
    }
    fn log(&self, r: &Record) {
        if !self.enabled(r.metadata()) || !r.target().starts_with("nexus") {
            return;
        }
        let line = format!("{} [{}] {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), r.level(), r.args());
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        if let Ok(mut g) = self.file.lock() {
            if let Some(f) = g.as_mut() {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }
    fn flush(&self) {}
}

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("nexus.log");
    if std::fs::metadata(&path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("nexus.old.log"));
    }
    let file = OpenOptions::new().create(true).append(true).open(&path).ok();
    let logger = Box::leak(Box::new(FileLogger { file: Mutex::new(file) }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(LevelFilter::Debug);
    }
}
