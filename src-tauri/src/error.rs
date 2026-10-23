use serde::{Serialize, Serializer};

/// Fehler, die an die Oberfläche weitergegeben werden. Die Meldung ist für Anwender formuliert.
#[derive(Debug)]
pub struct AppError(pub String);

pub type AppResult<T> = Result<T, AppError>;

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError(s.into())
    }
}

macro_rules! from_err {
    ($t:ty, $prefix:expr) => {
        impl From<$t> for AppError {
            fn from(e: $t) -> Self {
                AppError(format!("{}: {}", $prefix, e))
            }
        }
    };
}

from_err!(rusqlite::Error, "Datenbankfehler");
from_err!(serde_json::Error, "Datenformat ungültig");
from_err!(reqwest::Error, "Netzwerkfehler");
from_err!(tauri::Error, "Anwendungsfehler");
from_err!(trash::Error, "Papierkorb-Fehler");

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        // Windows liefert Systemmeldungen in der Systemsprache (z. B. Russisch) –
        // daher die häufigen Fehlercodes selbst auf Deutsch formulieren.
        let by_code = match e.raw_os_error() {
            Some(2) | Some(3) => Some("Datei oder Ordner wurde nicht gefunden"),
            Some(5) => Some("Zugriff verweigert – fehlende Berechtigung"),
            Some(15) | Some(21) => Some("Das Laufwerk ist nicht bereit oder nicht angeschlossen"),
            Some(19) => Some("Das Laufwerk ist schreibgeschützt"),
            Some(32) | Some(33) => Some("Die Datei wird gerade von einem anderen Programm verwendet"),
            Some(39) | Some(112) => Some("Auf dem Laufwerk ist nicht genügend Speicherplatz frei"),
            Some(80) | Some(183) => Some("Zieldatei existiert bereits"),
            Some(123) => Some("Ungültiger Datei- oder Ordnername"),
            Some(206) => Some("Der Dateipfad ist zu lang"),
            Some(1392) => Some("Die Datei ist beschädigt und kann nicht gelesen werden"),
            _ => None,
        };
        if let Some(t) = by_code {
            return AppError(t.to_string());
        }
        let text = match e.kind() {
            NotFound => "Datei oder Ordner wurde nicht gefunden".to_string(),
            PermissionDenied => "Zugriff verweigert – fehlende Berechtigung".to_string(),
            AlreadyExists => "Zieldatei existiert bereits".to_string(),
            UnexpectedEof => "Die Datei ist unvollständig".to_string(),
            _ => match e.raw_os_error() {
                Some(code) => format!("Dateisystemfehler (Windows-Code {code})"),
                None => format!("Dateisystemfehler: {e}"),
            },
        };
        AppError(text)
    }
}
