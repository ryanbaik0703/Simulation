"""로컬 개발 서버 (캐시 비활성화). 실행: python serve.py  →  http://localhost:8765"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.geojson': 'application/json'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


# http.server.ThreadingHTTPServer는 Python 3.7부터 있음 → 학교 서버(3.6)에서도 되도록 직접 정의
class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    print(f'http://localhost:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), NoCacheHandler).serve_forever()
