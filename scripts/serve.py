#!/usr/bin/env python3
"""Loopback static frontend with one fixed, TLS-verified API upstream (stdlib)."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from http import HTTPStatus
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import mimetypes
from pathlib import Path
import re
import ssl
from urllib.parse import unquote, urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BACKEND = 'https://localhost:18443'
DEFAULT_CA = ROOT.parent / 'sfl_backend/deployment/.generated/tls.crt'
MAX_BODY_BYTES = 257 * 1024 * 1024
HOP_HEADERS = {'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade'}
METHODS = {'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'}


@dataclass(frozen=True)
class Backend:
    scheme: str
    hostname: str
    port: int
    authority: str
    context: ssl.SSLContext | None = None
    timeout: float = 150.

    def connect(self):
        if self.scheme == 'https':
            return http.client.HTTPSConnection(self.hostname, self.port, context=self.context,
                                               timeout=self.timeout)
        return http.client.HTTPConnection(self.hostname, self.port, timeout=self.timeout)


def backend_target(url=DEFAULT_BACKEND, ca=None, timeout=150.):
    parsed = urlsplit(url)
    if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or any(character.isspace() for character in url)):
        raise ValueError('backend-url 必须是 HTTP(S) 服务地址，不含路径、凭证或查询参数')
    try:
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        raise ValueError('backend-url 端口无效') from None
    if not 0 < timeout <= 300 or not 1 <= port <= 65535:
        raise ValueError('后端端口或 timeout 无效')
    context = None
    if parsed.scheme == 'https':
        certificate = Path(ca) if ca is not None else DEFAULT_CA if url.rstrip('/') == DEFAULT_BACKEND else None
        if certificate is not None and not certificate.is_file():
            raise ValueError('找不到后端 CA 证书；请先启动后端或使用 --ca 指定证书')
        context = ssl.create_default_context(cafile=str(certificate) if certificate else None)
    return Backend(parsed.scheme, parsed.hostname, port, parsed.netloc, context, timeout)


def hop_headers(headers):
    names = set(HOP_HEADERS)
    for value in headers.get_all('Connection', []):
        names.update(part.strip().lower() for part in value.split(','))
    return names


class DevelopmentServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # HTTP parser/socket exceptions may embed a raw request or credential.
        self.logger.info(json.dumps({'event': 'handler_closed'}))


def create_server(address, backend, *, web_root=None, logger=None):
    directory = Path(web_root or ROOT / 'web').resolve(strict=True)
    if not directory.is_dir():
        raise ValueError('web 根目录不存在')
    server = DevelopmentServer(address, Handler)
    server.backend = backend
    server.web_root = directory
    server.logger = logger or logging.getLogger('sfl_frontend.serve')
    return server


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'SFLFrontend'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(self.server.backend.timeout)

    def log_message(self, format, *arguments):
        # BaseHTTPRequestHandler normally logs the entire request target.
        pass

    def record(self, status, route, event='response'):
        method = getattr(self, 'command', '')
        self.server.logger.info(json.dumps({'event': event, 'method': method if method in METHODS else 'OTHER',
                                            'route': route, 'status': int(status)}))

    def error_json(self, status, message, *, route='request'):
        self.close_connection = True
        identity = 'devproxy_' + uuid.uuid4().hex
        data = json.dumps({'code': int(status) * 100, 'message': message,
                           'data': None, 'request_id': identity}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Request-ID', identity)
        self.send_header('Connection', 'close')
        self.end_headers()
        if getattr(self, 'command', '') != 'HEAD':
            try:
                self.wfile.write(data)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        self.record(status, route)

    def send_error(self, code, message=None, explain=None):
        self.error_json(code, HTTPStatus(code).phrase)

    def dispatch(self):
        try:
            target = urlsplit(self.path)
        except ValueError:
            return self.error_json(400, '请求路径格式错误')
        if (target.scheme or target.netloc or not self.path.startswith('/')
                or any(ord(character) < 32 or ord(character) > 127 for character in self.path)):
            return self.error_json(400, '只接受当前服务的相对请求路径')
        if any(target.path == '/'+name or target.path.startswith('/'+name+'/') for name in ('api', 'health')):
            return self.proxy('health' if target.path.startswith('/health') else 'api')
        return self.static(target.path)

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = dispatch

    def proxy(self, route):
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get_all('Transfer-Encoding', []) or len(lengths) > 1:
            return self.error_json(400, '请使用单一 Content-Length 请求体', route=route)
        if lengths and (len(lengths[0]) > 12 or re.fullmatch(r'[0-9]+', lengths[0]) is None):
            return self.error_json(400, 'Content-Length 无效', route=route)
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY_BYTES:
            return self.error_json(413, '请求体超过开发代理上限', route=route)
        upstream = self.server.backend.connect()
        started = False
        status = 502
        self.close_connection = True
        try:
            excluded = hop_headers(self.headers) | {'host', 'content-length'}
            upstream.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            upstream.putheader('Host', self.server.backend.authority)
            upstream.putheader('Connection', 'close')
            for key, value in self.headers.raw_items():
                if key.lower() not in excluded:
                    upstream.putheader(key, value)
            if lengths or self.command in {'POST', 'PUT', 'PATCH'}:
                upstream.putheader('Content-Length', str(length))
            upstream.endheaders()
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(64 * 1024, remaining))
                if not chunk:
                    raise ConnectionResetError('client body ended')
                upstream.send(chunk)
                remaining -= len(chunk)
            response = upstream.getresponse()
            status = response.status
            self.send_response(status)
            excluded = hop_headers(response.headers) | {'server', 'date'}
            for key, value in response.getheaders():
                if key.lower() not in excluded:
                    self.send_header(key, value)
            # http.client decodes upstream chunks. Close-delimited downstream
            # framing avoids buffering and does not forward stale chunk headers.
            self.send_header('Connection', 'close')
            self.end_headers()
            started = True
            if self.command != 'HEAD':
                while True:
                    chunk = response.read1(64 * 1024)
                    if not chunk:
                        if response.length not in (None, 0):
                            raise http.client.IncompleteRead(b'')
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()  # SSE first frames do not wait for EOF.
            self.record(status, route)
        except (BrokenPipeError, ConnectionResetError):
            if not started:
                self.error_json(502, '后端连接失败；请确认真实后端地址及 CA 证书', route=route)
            else:
                self.record(status, route, 'client_disconnected')
        except (OSError, TimeoutError, http.client.HTTPException):
            if not started:
                self.error_json(502, '后端连接失败；请确认真实后端地址及 CA 证书', route=route)
            else:
                # Once headers are sent, truncation must close the response;
                # replacing a stream with a successful mock is never allowed.
                self.record(status, route, 'upstream_stream_closed')
        finally:
            upstream.close()

    def static(self, path):
        if self.command not in {'GET', 'HEAD'}:
            return self.error_json(405, '静态页面仅支持 GET / HEAD', route='static')
        try:
            decoded = unquote(path, errors='strict')
            parts = decoded.lstrip('/').split('/')
            if any(part == '..' or part.startswith('.') for part in parts if part):
                raise ValueError('outside static root')
            file = (self.server.web_root / decoded.lstrip('/')).resolve()
            if file.is_dir():
                file = (file / 'index.html').resolve()
            if not file.is_relative_to(self.server.web_root) or not file.is_file():
                raise ValueError('missing static file')
            stream = file.open('rb')
        except (ValueError, OSError, UnicodeError):
            return self.error_json(404, '静态资源不存在', route='static')
        with stream:
            size = file.stat().st_size
            content_type = ('application/javascript' if file.suffix in {'.js', '.mjs'} else
                            mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            if self.command != 'HEAD':
                try:
                    while chunk := stream.read(64 * 1024):
                        self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
            self.record(200, 'static')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1', choices=('127.0.0.1', 'localhost'))
    parser.add_argument('--port', type=int, default=8412)
    parser.add_argument('--backend-url', default=DEFAULT_BACKEND)
    parser.add_argument('--ca', type=Path)
    parser.add_argument('--timeout', type=float, default=150.)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('port 必须在 1–65535 范围内')
    try:
        backend = backend_target(args.backend_url, args.ca, args.timeout)
    except (ValueError, OSError, ssl.SSLError) as error:
        parser.error(str(error))
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    try:
        server = create_server((args.host, args.port), backend)
    except (OSError, ValueError):
        parser.error('无法启动；请确认 web 目录存在且本机监听端口未被占用')
    print(json.dumps({'frontend': f'http://{args.host}:{args.port}',
                      'backend': f'{backend.scheme}://{backend.authority}', 'tls_verified': backend.scheme == 'https'}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
