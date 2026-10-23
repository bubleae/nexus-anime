"""Asyncio-Eventloop im Hintergrund-Thread mit threadsicherer Rückgabe an Tk.

Tkinter darf nur aus dem Hauptthread angefasst werden. Deshalb laufen alle
Netzwerk-/IO-Coroutinen in einem eigenen Loop, und ihre Ergebnisse landen in
einer Queue, die der Tk-Mainloop alle ``POLL_MS`` Millisekunden abarbeitet.
"""
from __future__ import annotations

import asyncio
import logging
import queue
import threading
import tkinter as tk
from concurrent.futures import Future
from typing import Any, Callable, Coroutine, TypeVar

T = TypeVar("T")
log = logging.getLogger(__name__)


class AsyncRunner:
    POLL_MS = 16

    def __init__(self, root: tk.Misc) -> None:
        self._root = root
        self._closed = False
        self._loop = asyncio.new_event_loop()
        self._ui_queue: queue.SimpleQueue[Callable[[], None]] = queue.SimpleQueue()
        self._thread = threading.Thread(target=self._run_loop, name="async-runner", daemon=True)
        self._thread.start()
        self._root.after(self.POLL_MS, self._drain)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _drain(self) -> None:
        while True:
            try:
                callback = self._ui_queue.get_nowait()
            except queue.Empty:
                break
            try:
                callback()
            except Exception:
                log.exception("UI-Callback fehlgeschlagen")
        if not self._closed:
            self._root.after(self.POLL_MS, self._drain)

    def submit(
        self,
        coro: Coroutine[Any, Any, T],
        on_done: Callable[[T], None] | None = None,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> Future[T]:
        """Startet ``coro`` im Hintergrund; Callbacks laufen im Tk-Thread."""
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)

        def _finished(f: Future[T]) -> None:
            if f.cancelled() or self._closed:
                return
            exc = f.exception()
            if exc is not None:
                if on_error is not None:
                    self._ui_queue.put(lambda: on_error(exc))
                else:
                    log.error("Hintergrundaufgabe fehlgeschlagen", exc_info=exc)
            elif on_done is not None:
                result = f.result()
                self._ui_queue.put(lambda: on_done(result))

        future.add_done_callback(_finished)
        return future

    def run_blocking(
        self,
        fn: Callable[..., T],
        *args: Any,
        on_done: Callable[[T], None] | None = None,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> Future[T]:
        """Führt eine blockierende Funktion (z. B. Ordner-Scan) im Threadpool aus."""
        return self.submit(asyncio.to_thread(fn, *args), on_done, on_error)

    def shutdown(self, cleanup: Coroutine[Any, Any, Any] | None = None, timeout: float = 2.0) -> None:
        self._closed = True
        if cleanup is not None:
            try:
                asyncio.run_coroutine_threadsafe(cleanup, self._loop).result(timeout)
            except Exception:
                log.warning("Aufräumen beim Beenden fehlgeschlagen", exc_info=True)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout)
