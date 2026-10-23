"""
nexus – Laufzeitmodul für Python-Plugins von NEXUS ANIME.

Ein Python-Plugin ist ein normales Skript (main.py), das `import nexus` nutzt. Es läuft als eigener
Prozess; jeder Aufruf wie `nexus.ui.toast("success", "Hallo")` wird an die App geschickt und
wartet auf die Antwort. Funktionen, die du übergibst (z. B. on_click=...), ruft die App später auf.

Namen werden automatisch übersetzt: `nexus.ui.add_page(...)` ruft `nexus.ui.addPage(...)` der
JavaScript-API auf. Schlüsselwort-Argumente werden zu einem Objekt (mit camelCase-Schlüsseln)
zusammengefasst, z. B. `add_page(id="x", title="Y", html=fn)` → `addPage({id, title, html})`.

Ergebnisse sind Dicts mit Attributzugriff: `episode.file_name`, `episode.fileName` und
`episode["fileName"]` funktionieren gleichermaßen.

print() erscheint im Protokoll der App (Einstellungen → Daten & Datenschutz → Protokolle).
"""

from __future__ import annotations

import itertools
import json
import os
import runpy
import sys
import threading
import traceback
from typing import Any, Callable

__all__ = ["call", "on", "NexusError", "Obj", "plugin_id", "data_dir", "plugin_dir"]

plugin_id: str = os.environ.get("NEXUS_PLUGIN_ID", "")
data_dir: str = os.environ.get("NEXUS_DATA_DIR", "")
plugin_dir: str = os.getcwd()


class NexusError(Exception):
    """Fehler, den die App bei einem Aufruf gemeldet hat."""


# ---------------------------------------------------------------------------
# Hilfen
# ---------------------------------------------------------------------------

def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


class Obj(dict):
    """Dict mit Attributzugriff (auch in snake_case)."""

    def __getattr__(self, key: str) -> Any:
        if key in self:
            return self[key]
        c = _camel(key)
        if c in self:
            return self[c]
        raise AttributeError(key)

    def __setattr__(self, key: str, value: Any) -> None:
        self[key] = value


def _wrap(v: Any) -> Any:
    if isinstance(v, dict):
        return Obj({k: _wrap(x) for k, x in v.items()})
    if isinstance(v, list):
        return [_wrap(x) for x in v]
    return v


# ---------------------------------------------------------------------------
# Verbindung zur App
# ---------------------------------------------------------------------------

_out = sys.stdout  # reserviert für das Protokoll; print() geht nach stderr
_write_lock = threading.Lock()
_ids = itertools.count(1)
_pending: dict[int, list] = {}
_callbacks: dict[str, Callable] = {}
_cb_ids: dict[int, str] = {}


def _register(fn: Callable) -> dict:
    key = _cb_ids.get(id(fn))
    if key is None:
        key = f"cb{next(_ids)}"
        _cb_ids[id(fn)] = key
        _callbacks[key] = fn
    return {"__cb": key}


def _default(o: Any) -> Any:
    if callable(o):
        return _register(o)
    if isinstance(o, (set, tuple)):
        return list(o)
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return str(o)


def _send(msg: dict) -> None:
    line = json.dumps(msg, ensure_ascii=False, default=_default)
    with _write_lock:
        _out.write(line + "\n")
        _out.flush()


def call(path: str, /, *args: Any, **kwargs: Any) -> Any:
    """Ruft eine Funktion der nexus-API auf, z. B. call("ui.toast", "info", "Hallo").

    Alle Schlüsselwort-Argumente gehen an die App (auch Namen wie method= oder timeout=)."""
    if kwargs:
        args = (*args, {_camel(k): v for k, v in kwargs.items()})
    cid = next(_ids)
    ev = threading.Event()
    slot = [ev, None, None]
    _pending[cid] = slot
    _send({"type": "call", "id": cid, "method": path, "args": list(args)})
    ev.wait()
    if slot[2] is not None:
        raise NexusError(slot[2])
    return _wrap(slot[1])


class _Proxy:
    """`nexus.ui.add_page(...)` → call("ui.addPage", ...)."""

    def __init__(self, path: str) -> None:
        self._path = path

    def __getattr__(self, name: str) -> "_Proxy":
        if name.startswith("__"):
            raise AttributeError(name)
        return _Proxy(f"{self._path}.{_camel(name)}" if self._path else _camel(name))

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return call(self._path, *args, **kwargs)

    def __repr__(self) -> str:
        return f"<nexus.{self._path}>"


# Bereiche der API (siehe PLUGINS.md)
ui = _Proxy("ui")
events = _Proxy("events")
library = _Proxy("library")
player = _Proxy("player")
settings = _Proxy("settings")
storage = _Proxy("storage")
config = _Proxy("config")
http = _Proxy("http")
fs = _Proxy("fs")
shell = _Proxy("shell")
db = _Proxy("db")
api = _Proxy("api")
app = _Proxy("app")
plugins = _Proxy("plugins")
discover = _Proxy("discover")
utils = _Proxy("utils")


def log(level: str, *msg: Any) -> None:
    call("log", level, *msg)


def invoke(cmd: str, args: dict | None = None) -> Any:
    """Beliebiger Backend-Befehl der App."""
    return call("invoke", cmd, args or {})


def on(event: str) -> Callable[[Callable], Callable]:
    """Dekorator: @nexus.on("episode:watched")"""

    def deco(fn: Callable) -> Callable:
        events.on(event, fn)
        return fn

    return deco


# ---------------------------------------------------------------------------
# Empfang
# ---------------------------------------------------------------------------

def _run_callback(mid: int, key: str, args: list) -> None:
    fn = _callbacks.get(key)
    try:
        if fn is None:
            raise NexusError("Unbekannte Funktion")
        result = fn(*[_wrap(a) for a in args][: _arity(fn, len(args))])
        _send({"type": "result", "id": mid, "value": result})
    except Exception as e:  # noqa: BLE001 – Fehler an die App melden
        traceback.print_exc()
        _send({"type": "error", "id": mid, "error": f"{type(e).__name__}: {e}"})


def _arity(fn: Callable, n: int) -> int:
    """Erlaubt Funktionen mit weniger Parametern, als die App übergibt (z. B. def klick(): …)."""
    try:
        import inspect

        params = inspect.signature(fn).parameters.values()
        if any(p.kind in (p.VAR_POSITIONAL,) for p in params):
            return n
        return min(n, sum(1 for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)))
    except (TypeError, ValueError):
        return n


def _reader() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        kind = msg.get("type")
        if kind in ("result", "error"):
            slot = _pending.pop(msg.get("id"), None)
            if slot:
                slot[1] = msg.get("value")
                slot[2] = msg.get("error") if kind == "error" else None
                slot[0].set()
        elif kind == "invoke":
            threading.Thread(target=_run_callback, args=(msg["id"], msg["cb"], msg.get("args") or []), daemon=True).start()
    # App beendet oder Plugin deaktiviert
    os._exit(0)


def _main(script: str) -> None:
    """Startpunkt (wird von der App aufgerufen)."""
    sys.stdout = sys.stderr
    sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
    threading.Thread(target=_reader, daemon=True).start()
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit:
        pass
    except BaseException:  # noqa: BLE001
        _send({"type": "fatal", "error": traceback.format_exc()})
        sys.stderr.flush()
        os._exit(1)
    _send({"type": "ready"})
    threading.Event().wait()
