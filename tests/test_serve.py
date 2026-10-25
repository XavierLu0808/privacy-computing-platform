"""Real local HTTP/TLS fixtures test transport behavior without production mocks."""
from contextlib import contextmanager
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import logging
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('frontend_serve', ROOT/'scripts/serve.py')
SERVE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SERVE
SPEC.loader.exec_module(SERVE)


class Upstream(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def respond(self, status, body, **headers):
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        for name, value in headers.items():
            self.send_header(name.replace('_', '-'), value)
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        result = json.dumps({'method': self.command, 'target': self.path,
                             'authorization': self.headers.get('Authorization'),
                             'body': body.decode(), 'connection_named_header': self.headers.get('X-Hop')}).encode()
        self.respond(201, result, Content_Type='application/json', X_Request_ID='upstream-post')

    def do_GET(self):
        if self.path.startswith('/api/v1/events'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Request-ID', 'upstream-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(b'event: snapshot\ndata: {"ok":true}\n\n')
                self.wfile.flush()
                self.server.release.wait(2.)
                for _ in range(100):
                    self.wfile.write(b': heartbeat\n\n')
                    self.wfile.flush()
                    time.sleep(.01)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self.server.stream_closed.set()
        elif self.path.startswith('/api/v1/error'):
            self.respond(409, b'{"code":40901,"message":"blocked"}', Content_Type='application/json',
                         Content_Disposition='attachment; filename="error.json"', X_Request_ID='upstream-error')
        elif self.path.startswith('/api/v1/reset'):
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
        elif self.path.startswith('/api/v1/stall'):
            self.server.release.wait(.2)
            self.close_connection = True
        else:
            self.respond(200, b'{"status":"alive"}', Content_Type='application/json', X_Request_ID='upstream-health')


@contextmanager
def running(server):
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        if hasattr(server, 'release'):
            server.release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.)


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.web = self.root/'web'
        self.web.mkdir()
        (self.web/'index.html').write_text('<h1>Real frontend fixture</h1>')
        (self.web/'client.mjs').write_text('export const value=1;')
        self.log = io.StringIO()
        self.logger = logging.getLogger('test-frontend-'+self.id())
        self.logger.handlers = [logging.StreamHandler(self.log)]
        self.logger.propagate = False
        self.logger.setLevel(logging.INFO)
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.upstream.daemon_threads = True
        self.upstream.release = threading.Event()
        self.upstream.stream_closed = threading.Event()
        self.addCleanup(self.directory.cleanup)
        self.up_context = running(self.upstream)
        self.up_context.__enter__()
        self.addCleanup(self.up_context.__exit__, None, None, None)
        backend = SERVE.backend_target('http://127.0.0.1:'+str(self.upstream.server_port), timeout=2.)
        self.proxy = SERVE.create_server(('127.0.0.1', 0), backend, web_root=self.web, logger=self.logger)
        self.proxy_context = running(self.proxy)
        self.proxy_context.__enter__()
        self.addCleanup(self.proxy_context.__exit__, None, None, None)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.proxy.server_port, timeout=2.)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_post_body_bearer_and_request_id_preserved_without_hop_headers(self):
        status, headers, body = self.request('POST', '/api/v1/items?project=p1', b'{"value":12}',
            {'Authorization': 'Bearer fixture-private-token', 'Content-Type': 'application/json',
             'Connection': 'X-Hop', 'X-Hop': 'discard-this'})
        result = json.loads(body)
        self.assertEqual(status, 201)
        self.assertEqual(result['body'], '{"value":12}')
        self.assertEqual(result['authorization'], 'Bearer fixture-private-token')
        self.assertEqual(result['target'], '/api/v1/items?project=p1')
        self.assertIsNone(result['connection_named_header'])
        self.assertEqual(headers['X-Request-ID'], 'upstream-post')

    def test_upstream_error_status_export_headers_and_body_preserved(self):
        status, headers, body = self.request('GET', '/api/v1/error')
        self.assertEqual(status, 409)
        self.assertEqual(headers['Content-Disposition'], 'attachment; filename="error.json"')
        self.assertEqual(headers['X-Request-ID'], 'upstream-error')
        self.assertEqual(json.loads(body)['code'], 40901)

    def test_health_is_proxied_and_frontend_is_static(self):
        self.assertEqual(self.request('GET', '/health/live')[2], b'{"status":"alive"}')
        status, headers, body = self.request('GET', '/')
        self.assertEqual(status, 200)
        self.assertIn(b'Real frontend fixture', body)
        self.assertIn('javascript', self.request('GET', '/client.mjs')[1]['Content-Type'])
        self.assertEqual(self.request('POST', '/', 'data')[0], 405)

    def test_traversal_and_symlink_cannot_escape_static_root(self):
        outside = self.root/'credential.txt'
        outside.write_text('outside-private-value')
        (self.web/'symlink.txt').symlink_to(outside)
        for path in ('/%2e%2e/credential.txt', '/symlink.txt', '/.git/config', '/scripts/serve.py'):
            status, _, body = self.request('GET', path)
            self.assertEqual(status, 404)
            self.assertNotIn(b'outside-private-value', body)

    def test_sse_first_frame_arrives_before_upstream_finishes(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.proxy.server_port, timeout=1.)
        started = time.monotonic()
        try:
            connection.request('GET', '/api/v1/events', headers={'Authorization': 'Bearer stream-token'})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.fp.readline(), b'event: snapshot\n')
            self.assertLess(time.monotonic()-started, 1.)
            self.assertFalse(self.upstream.stream_closed.is_set())
        finally:
            self.upstream.release.set()
            connection.close()

    def test_disconnected_sse_client_releases_upstream_without_tracebacks(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.proxy.server_port, timeout=1.)
        connection.request('GET', '/api/v1/events?access_token=secret-query-value')
        response = connection.getresponse()
        self.assertEqual(response.fp.readline(), b'event: snapshot\n')
        response.close()
        connection.close()
        self.upstream.release.set()
        self.assertTrue(self.upstream.stream_closed.wait(2.))
        self.assertNotIn('Traceback', self.log.getvalue())
        self.assertNotIn('secret-query-value', self.log.getvalue())

    def test_unavailable_or_reset_upstream_is_explicit_502_json(self):
        with socket.socket() as unused:
            unused.bind(('127.0.0.1', 0))
            port = unused.getsockname()[1]
        self.proxy.backend = SERVE.backend_target('http://127.0.0.1:'+str(port), timeout=.3)
        status, headers, body = self.request('GET', '/api/v1/items')
        self.assertEqual(status, 502)
        self.assertEqual(headers['Content-Type'], 'application/json; charset=utf-8')
        self.assertEqual(json.loads(body)['code'], 50200)
        self.assertNotIn('mock', body.decode().lower())
        self.proxy.backend = SERVE.backend_target('http://127.0.0.1:'+str(self.upstream.server_port), timeout=.3)
        self.assertEqual(self.request('GET', '/api/v1/reset')[0], 502)

    def test_logs_never_contain_credentials_body_or_full_query(self):
        self.request('POST', '/api/v1/items?token=query-secret', 'body-secret',
            {'Authorization': 'Bearer auth-secret', 'Cookie': 'session=cookie-secret'})
        log = self.log.getvalue()
        for secret in ('query-secret', 'body-secret', 'auth-secret', 'cookie-secret', '?token=', 'Authorization'):
            self.assertNotIn(secret, log)
        self.assertIn('"route": "api"', log)

    def test_timeout_before_headers_is_502_without_raw_exception(self):
        self.proxy.backend = SERVE.backend_target('http://127.0.0.1:'+str(self.upstream.server_port), timeout=.03)
        status, _, body = self.request('GET', '/api/v1/stall?secret=never-log-this')
        self.assertEqual(status, 502)
        self.assertNotIn('Traceback', body.decode())
        self.assertNotIn('never-log-this', self.log.getvalue())

    def test_absolute_proxy_targets_and_ambiguous_framing_are_rejected(self):
        self.assertEqual(SERVE.Backend('http', 'localhost', 8000, 'localhost:8000').timeout, 150.)
        self.assertEqual(SERVE.backend_target('http://localhost:8000').timeout, 150.)
        self.assertEqual(SERVE.backend_target('http://localhost:8000', timeout=300.).timeout, 300.)
        with self.assertRaises(ValueError):
            SERVE.backend_target('http://localhost:8000', timeout=301.)
        self.assertEqual(self.request('GET', 'http://other.invalid/api/v1/items')[0], 400)
        self.assertEqual(self.request('POST', '/api/v1/items', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.request('POST', '/api/v1/items', headers={'Content-Length': '9'*5000})[0], 400)
        for url in ('file:///etc/passwd', 'https://user:password@localhost:18443',
                    'http://localhost:8000/api/v1', 'http://localhost:8000?target=other',
                    'http://localhost:0', 'http://:@localhost:8000'):
            with self.assertRaises(ValueError):
                SERVE.backend_target(url)

    @unittest.skipUnless(shutil.which('openssl'), 'openssl required to generate a local TLS fixture')
    def test_https_requires_valid_ca_and_hostname(self):
        certificate, key = self.root/'ca.crt', self.root/'tls.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
            '-days', '1', '-keyout', str(key), '-out', str(certificate), '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], check=True, capture_output=True)
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        upstream.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        upstream.socket = context.wrap_socket(upstream.socket, server_side=True)
        with running(upstream):
            origin = 'https://localhost:'+str(upstream.server_port)
            self.proxy.backend = SERVE.backend_target(origin, timeout=1.)
            self.assertEqual(self.request('GET', '/health/live')[0], 502)
            self.proxy.backend = SERVE.backend_target(origin, certificate, timeout=1.)
            self.assertTrue(self.proxy.backend.context.check_hostname)
            self.assertEqual(self.proxy.backend.context.verify_mode, ssl.CERT_REQUIRED)
            self.assertEqual(self.request('GET', '/health/live')[0], 200)


if __name__ == '__main__':
    unittest.main()
