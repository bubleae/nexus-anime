"""Tests für extractor.py mit einem lokalen Test-Server. Start: python -m unittest test_extractor"""

import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from extractor import NoStreamFound, ProtectedStream, extract, find_candidates

MASTER = b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n"
VARIANT = b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n"
DRM = b"#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n#EXTINF:6,\nseg0.ts\n"
MP4 = b"\x00\x00\x00\x20ftypisom" + b"\x00" * 200

PAGES = {
    "/video-tag.html": "<html><head><title>Folge 1</title></head><body><video><source src='/media/ep1.mp4' type='video/mp4'>"
                       "<track kind='subtitles' src='/subs/ep1.vtt' srclang='de' label='Deutsch'></video></body></html>",
    "/script.html": "<!doctype html><html><body><div id=p></div><script>jwplayer('p').setup({file:\"http:\\/\\/HOST\\/hls\\/master.m3u8\",ads:'/ads/preroll.mp4'});</script></body></html>",
    "/outer.html": "<html><body><h1>Serie</h1><iframe src='/embed/42'></iframe></body></html>",
    "/embed/42": "<html><head><meta property='og:title' content='Eingebettet'></head><body><script>var cfg={sources:[{src:'/hls/master.m3u8'}]};</script></body></html>",
    "/drm.html": "<html><body><video src='/drm/master.m3u8'></video></body></html>",
    "/empty.html": "<html><body><div id='app'></div><script src='/bundle.js'></script></body></html>",
    "/referer.html": "<html><body><video src='/protected/ep.mp4'></video></body></html>",
}
FILES = {
    "/hls/master.m3u8": ("application/vnd.apple.mpegurl", MASTER),
    "/hls/low/index.m3u8": ("application/vnd.apple.mpegurl", VARIANT),
    "/drm/master.m3u8": ("application/vnd.apple.mpegurl", DRM),
    "/media/ep1.mp4": ("video/mp4", MP4),
    "/raw/video.bin": ("application/octet-stream", MP4),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/protected/ep.mp4":
            if not (self.headers.get("Referer") or "").endswith("/referer.html"):
                return self._send(403, "text/plain", b"forbidden")
            return self._send(206, "video/mp4", MP4)
        if path in FILES:
            ct, body = FILES[path]
            return self._send(200, ct, body)
        if path in PAGES:
            return self._send(200, "text/html; charset=utf-8", PAGES[path].replace("HOST", self.headers["Host"]).encode())
        self._send(404, "text/plain", b"not found")

    def _send(self, code, ct, body):
        self.send_response(code)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class ExtractorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_direct_links(self):
        self.assertEqual(extract(self.base + "/hls/master.m3u8").kind, "hls")
        self.assertEqual(extract(self.base + "/media/ep1.mp4").kind, "file")
        # octet-stream, aber Dateianfang ist MP4
        self.assertEqual(extract(self.base + "/raw/video.bin").kind, "file")

    def test_video_tag_with_subtitles(self):
        s = extract(self.base + "/video-tag.html")
        self.assertEqual((s.kind, s.url, s.title), ("file", self.base + "/media/ep1.mp4", "Folge 1"))
        self.assertEqual(s.subtitles[0]["lang"], "de")
        self.assertEqual(s.headers["Referer"], self.base + "/video-tag.html")

    def test_escaped_player_config_prefers_hls_over_ads(self):
        s = extract(self.base + "/script.html")
        self.assertEqual((s.kind, s.url), ("hls", self.base + "/hls/master.m3u8"))

    def test_iframe(self):
        s = extract(self.base + "/outer.html")
        self.assertEqual((s.url, s.page, s.title), (self.base + "/hls/master.m3u8", self.base + "/embed/42", "Eingebettet"))
        with self.assertRaises(NoStreamFound):
            extract(self.base + "/outer.html", depth=0)

    def test_referer_required(self):
        self.assertEqual(extract(self.base + "/referer.html").url, self.base + "/protected/ep.mp4")

    def test_drm_rejected(self):
        with self.assertRaises(ProtectedStream):
            extract(self.base + "/drm.html")

    def test_js_only_page(self):
        with self.assertRaises(NoStreamFound) as cm:
            extract(self.base + "/empty.html")
        self.assertTrue(cm.exception.is_page)
        self.assertIn("Webansicht", str(cm.exception))

    def test_candidates_ranking(self):
        media, _, _, _ = find_candidates(
            '<script>var a="https://cdn.example/v/480p.mp4", b="https://cdn.example/v/1080p.mp4", c="https://cdn.example/hls/master.m3u8?t=1&amp;x=2";</script>',
            "https://example.org/",
        )
        self.assertEqual(media, ["https://cdn.example/hls/master.m3u8?t=1&x=2", "https://cdn.example/v/1080p.mp4", "https://cdn.example/v/480p.mp4"])


if __name__ == "__main__":
    unittest.main()
