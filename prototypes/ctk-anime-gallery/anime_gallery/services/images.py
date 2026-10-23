"""Cover-Downloads mit Platten- und Speicher-Cache.

Download *und* Dekodieren/Skalieren laufen außerhalb des UI-Threads; die UI
bekommt ein fertig zugeschnittenes ``PIL.Image`` und wickelt es nur noch in
ein ``CTkImage``.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
from collections import OrderedDict
from pathlib import Path

from PIL import Image, ImageOps

from anime_gallery.core.http import HttpClientProvider


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _prepare(path: Path, size: tuple[int, int]) -> Image.Image:
    with Image.open(path) as img:
        return ImageOps.fit(img.convert("RGB"), size, Image.Resampling.LANCZOS)


class ImageService:
    def __init__(self, http: HttpClientProvider, cache_dir: Path, max_parallel: int = 6, memory_items: int = 400) -> None:
        self._http = http
        self._dir = cache_dir
        self._semaphore = asyncio.Semaphore(max_parallel)
        self._memory: OrderedDict[tuple[str, int, int], Image.Image] = OrderedDict()
        self._memory_items = memory_items

    async def load(self, url: str, size: tuple[int, int]) -> Image.Image:
        key = (url, *size)
        if key in self._memory:
            self._memory.move_to_end(key)
            return self._memory[key]

        path = self._dir / (hashlib.sha1(url.encode()).hexdigest() + ".img")
        if not path.exists():
            async with self._semaphore:
                resp = await self._http.get().get(url)
                resp.raise_for_status()
                await asyncio.to_thread(_write_atomic, path, resp.content)

        image = await asyncio.to_thread(_prepare, path, size)
        self._memory[key] = image
        while len(self._memory) > self._memory_items:
            self._memory.popitem(last=False)
        return image
