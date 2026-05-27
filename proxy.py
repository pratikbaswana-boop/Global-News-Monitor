import http.server
import socketserver
import urllib.request
import os
import mimetypes

PORT = 8080
API_TARGET = "http://localhost:3000"
STATIC_DIR = "/Users/pratikbaswana/Downloads/Global-News-Monitorzip/artifacts/global-news/dist/public"

class ReuseAddrTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/"):
            self.proxy(API_TARGET + self.path)
        else:
            self.serve_static()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self.proxy(API_TARGET + self.path, method="POST")
        else:
            self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self.proxy(API_TARGET + self.path, method="DELETE")
        else:
            self.send_error(404)

    def do_PATCH(self):
        if self.path.startswith("/api/"):
            self.proxy(API_TARGET + self.path, method="PATCH")
        else:
            self.send_error(404)

    def do_PUT(self):
        if self.path.startswith("/api/"):
            self.proxy(API_TARGET + self.path, method="PUT")
        else:
            self.send_error(404)

    def serve_static(self):
        rel_path = self.path.lstrip("/")
        if not rel_path or rel_path.endswith("/"):
            rel_path = "index.html"
        file_path = os.path.join(STATIC_DIR, rel_path)
        if not os.path.isfile(file_path):
            file_path = os.path.join(STATIC_DIR, "index.html")
        try:
            with open(file_path, 'rb') as f:
                data = f.read()
            ctype = mimetypes.guess_type(file_path)[0] or 'application/octet-stream'
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(500, str(e))

    def proxy(self, url, method="GET"):
        try:
            content_length = self.headers.get('Content-Length')
            body = None
            if content_length:
                body = self.rfile.read(int(content_length))

            req = urllib.request.Request(url, method=method, data=body)
            for key, value in self.headers.items():
                if key.lower() not in ('host', 'content-length'):
                    req.add_header(key, value)
            req.add_header('Host', 'localhost:3000')

            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() not in ('transfer-encoding', 'content-encoding'):
                        self.send_header(key, value)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for key, value in e.headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(f'{{"error":"{str(e)}"}}'.encode())

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    with ReuseAddrTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Proxy serving on port {PORT}")
        httpd.serve_forever()
