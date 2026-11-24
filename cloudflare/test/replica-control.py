"""Container-test stand-in for the Worker's per-boot outbound binding."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path

root = Path('/tmp/replica-control')
root.mkdir(exist_ok=True)


class Control(BaseHTTPRequestHandler):
    def send(self, status, body=b''):
        self.send_response(status)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ('/credentials/config', '/credentials/restore', '/credentials/state'):
            self.send(200, json.dumps({'Version': 1, 'AccessKeyId': 'test', 'SecretAccessKey': 'test-secret'}).encode())
        elif self.path == '/status':
            self.send(409 if (root/'drain').exists() else 200)
        else:
            self.send(404)

    def do_POST(self):
        if self.path not in ('/publish','/released'):
            self.send(404)
            return
        (root/self.path[1:]).touch()
        self.send(200)


HTTPServer(('0.0.0.0',9050), Control).serve_forever()
