import http.server
import functools
import sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8532
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'
    handler = functools.partial(NoCacheHandler, directory=directory)
    http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
