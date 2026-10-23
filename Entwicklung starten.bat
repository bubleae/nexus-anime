@echo off
rem Startet NEXUS ANIME im Entwicklungsmodus direkt aus den Quelldateien (ohne EXE zu bauen).
rem Aenderungen an src\ (Oberflaeche) erscheinen sofort, Aenderungen an src-tauri\ (Rust)
rem werden automatisch neu uebersetzt und die App startet neu.
title NEXUS ANIME - Entwicklung
cd /d "%~dp0"

tasklist /FI "IMAGENAME eq nexus-anime.exe" 2>nul | find /I "nexus-anime.exe" >nul
if not errorlevel 1 (
  echo NEXUS ANIME laeuft bereits. Bitte zuerst die installierte App schliessen.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Erster Start: Abhaengigkeiten werden installiert ...
  call npm install || goto fehler
)

echo Starte NEXUS ANIME im Entwicklungsmodus ...
echo (Dieses Fenster offen lassen. Zum Beenden die App schliessen oder hier Strg+C druecken.)
call npm run tauri dev || goto fehler
exit /b 0

:fehler
echo.
echo Der Start ist fehlgeschlagen. Die Meldung steht oben.
pause
exit /b 1
