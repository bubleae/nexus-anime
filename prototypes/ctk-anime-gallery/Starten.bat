@echo off
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Erster Start: virtuelle Umgebung wird angelegt ...
    python -m venv .venv || goto :error
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :error
)

".venv\Scripts\python.exe" -m anime_gallery || goto :error
exit /b 0

:error
echo.
echo Start fehlgeschlagen - siehe Meldung oben.
pause
