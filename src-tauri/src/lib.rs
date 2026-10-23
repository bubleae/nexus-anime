//! NEXUS ANIME – Backend.
//!
//! Module:
//! - `parser`    Dateinamen-/Ordneranalyse (isoliert testbar)
//! - `db`        SQLite-Schema und Abfragen
//! - `scanner`   inkrementeller Scan der Quellordner
//! - `metadata`  optionale AniList-Anbindung
//! - `media`     Streaming der Originaldateien an den integrierten Player
//! - `subtitles` externe und eingebettete Untertitel → WebVTT
//! - `fileops`   optionale Bibliotheksorganisation (Kopieren/Verschieben mit Vorschau)
//! - `system`    Windows-Aktionen, Backups, Export, Diagnose
//! - `watcher`   Ordnerüberwachung und geplante Scans
//! - `plugins`   Plugin-Verwaltung und Fähigkeiten für Plugins

mod commands;
mod db;
mod error;
mod fileops;
mod links;
mod logger;
mod media;
mod metadata;
pub mod parser;
mod plugins;
mod scanner;
mod settings;
mod state;
mod subtitles;
mod system;
mod watcher;
mod webplayer;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

use state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("nexus", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // Dateizugriffe nicht im WebView-Thread ausführen
            std::thread::spawn(move || {
                responder.respond(media::handle(&app, request));
            });
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            logger::init(data_dir.join("logs"));
            log::info!("NEXUS ANIME {} startet", app.package_info().version);

            let db_path = system::resolve_db_path(&config_dir, &data_dir);
            let conn = db::open(&db_path).map_err(|e| e.to_string())?;
            db::migrate(&conn).map_err(|e| e.to_string())?;
            links::migrate(&conn).map_err(|e| e.to_string())?;
            plugins::migrate(&conn).map_err(|e| e.to_string())?;
            let settings = settings::load(&conn).unwrap_or_default();
            // Beim Start sind Laufwerke evtl. noch nicht verbunden – Verfügbarkeit sofort prüfen
            if let Ok(sources) = db::list_sources(&conn) {
                for s in sources {
                    let ok = std::path::Path::new(&s.path).is_dir();
                    let _ = conn.execute("UPDATE sources SET available = ?1 WHERE id = ?2", rusqlite::params![ok as i64, s.id]);
                    let _ = conn.execute(
                        "UPDATE episodes SET available = ?1 WHERE source_id = ?2 AND missing = 0",
                        rusqlite::params![ok as i64, s.id],
                    );
                }
            }

            app.manage(AppState {
                data_dir,
                db_path,
                conn: Mutex::new(conn),
                scanning: Arc::new(AtomicBool::new(false)),
                scan_cancel: Arc::new(AtomicBool::new(false)),
                metadata_running: Arc::new(AtomicBool::new(false)),
                watcher: Mutex::new(None),
                watch_dirty: Arc::new(Mutex::new(None)),
                last_scan_progress: Mutex::new(None),
            });

            if let Some(win) = app.get_webview_window("main") {
                if settings.window_mode == "maximized" {
                    let _ = win.maximize();
                }
                let _ = win.show();
            }

            let handle = app.handle().clone();
            watcher::configure(&handle);
            watcher::spawn_scheduler(handle.clone());
            if settings.scan_on_start {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = scanner::start_scan(&h, None, "startup");
                });
            } else if settings.auto_metadata {
                metadata::start_auto_fetch(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::list_series,
            commands::get_series_detail,
            commands::get_continue_watching,
            commands::list_episodes,
            commands::search,
            commands::set_favorite,
            commands::update_series,
            commands::create_series,
            commands::remove_series,
            commands::merge_series,
            commands::set_series_image,
            commands::reset_series_image,
            commands::reorder_series,
            commands::set_season_name,
            commands::assign_episodes,
            commands::update_episode,
            commands::move_episodes_to_season,
            commands::reorder_episodes,
            commands::unassign_episodes,
            commands::hide_episodes,
            commands::restore_episodes,
            commands::forget_episodes,
            commands::delete_episode_file,
            commands::find_duplicates,
            commands::get_playback,
            commands::save_progress,
            commands::mark_watched,
            commands::mark_series_watched,
            commands::save_thumbnail,
            commands::get_subtitle,
            commands::load_subtitle_file,
            commands::open_in_default_player,
            commands::reveal_in_explorer,
            commands::open_episode_folder,
            commands::open_series_folder,
            commands::open_path,
            commands::file_properties,
            commands::add_source,
            commands::remove_source,
            commands::set_source_enabled,
            commands::list_sources,
            commands::add_series_link,
            commands::remove_series_link,
            commands::open_link,
            commands::inspect_link,
            commands::create_series_from_link,
            commands::start_scan,
            commands::cancel_scan,
            commands::scan_status,
            commands::add_files,
            commands::metadata_search,
            commands::metadata_apply,
            commands::metadata_refresh,
            commands::discover_episodes,
            commands::discover_add,
            commands::metadata_clear,
            commands::get_settings,
            commands::save_settings,
            commands::reset_settings,
            commands::plan_file_operation,
            commands::execute_file_operation,
            commands::count_outside_library,
            commands::create_backup,
            commands::restore_backup,
            commands::list_backups,
            commands::export_library,
            commands::import_library,
            commands::clear_cache,
            commands::read_logs,
            commands::diagnostics,
            commands::move_database,
            commands::reset_database_location,
            commands::restart_app,
            commands::log_frontend,
            plugins::plugin_list,
            plugins::plugin_set_enabled,
            plugins::plugin_read_file,
            plugins::plugin_install,
            plugins::plugin_uninstall,
            plugins::plugin_create,
            plugins::plugin_storage_get,
            plugins::plugin_storage_set,
            plugins::plugin_http,
            webplayer::probe_stream,
            webplayer::open_web_player,
            webplayer::close_web_player,
            plugins::plugin_fs_read,
            plugins::plugin_fs_write,
            plugins::plugin_fs_list,
            plugins::plugin_fs_exists,
            plugins::plugin_run,
            plugins::plugin_sql,
            plugins::plugin_py_start,
            plugins::plugin_py_send,
            plugins::plugin_py_stop,
        ])
        .build(tauri::generate_context!())
        .expect("NEXUS ANIME konnte nicht gestartet werden")
        .run(|_, event| {
            // Python-Plugins laufen als eigene Prozesse – beim Beenden mit schließen
            if let tauri::RunEvent::Exit = event {
                plugins::stop_all_python();
            }
        });
}
