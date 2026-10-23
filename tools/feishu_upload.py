#!/usr/bin/env python3
"""把 Word 文档上传到飞书云空间：原文件 + 导入为飞书在线文档（docx），并打开链接分享。

凭据：/home/lmy/.config/feishu/app.env（FEISHU_APP_ID / FEISHU_APP_SECRET，自建应用 tenant token）。
同名文件再次上传时，先删掉文件夹里旧的同名文件和同名在线文档，再上传新版本（链接会变，脚本打印新链接）。

用法：
  python3 tools/feishu_upload.py --folder "隐私计算联邦学习软件原型" a.docx b.docx ...
输出：每个文件的原文件链接与在线文档链接（JSON 写到 docs/feishu-links.json）。
"""
import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

API = 'https://open.feishu.cn/open-apis'
ROOT = Path(__file__).resolve().parent.parent
ENV = Path('/home/lmy/.config/feishu/app.env')


def env():
    d = {}
    for line in ENV.read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            d[k.strip()] = v.strip()
    return d


def call(method, path, token=None, body=None, raw=None, ctype=None):
    url = path if path.startswith('http') else API + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Content-Type', ctype or 'application/json; charset=utf-8')
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        res = json.loads(e.read().decode() or '{}')
    if res.get('code') not in (0, None):
        raise RuntimeError('%s %s → %s %s' % (method, path, res.get('code'), res.get('msg')))
    return res.get('data', res)


def tenant_token():
    e = env()
    r = call('POST', '/auth/v3/tenant_access_token/internal',
             body={'app_id': e['FEISHU_APP_ID'], 'app_secret': e['FEISHU_APP_SECRET']})
    return r['tenant_access_token'] if 'tenant_access_token' in r else r


def multipart(fields, file_field, filename, content):
    b = uuid.uuid4().hex
    out = []
    for k, v in fields.items():
        out.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (b, k, v)).encode())
    ct = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    out.append(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: %s\r\n\r\n' % (
        b, file_field, filename, ct)).encode())
    out.append(content)
    out.append(('\r\n--%s--\r\n' % b).encode())
    return b''.join(out), 'multipart/form-data; boundary=' + b


def ensure_folder(tk, name):
    root = call('GET', '/drive/explorer/v2/root_folder/meta', tk)['token']
    page = call('GET', '/drive/v1/files?folder_token=%s&page_size=200' % root, tk)
    for f in page.get('files', []):
        if f['type'] == 'folder' and f['name'] == name:
            return f['token'], f.get('url')
    r = call('POST', '/drive/v1/files/create_folder', tk, {'name': name, 'folder_token': root})
    return r['token'], r.get('url')


def list_folder(tk, folder):
    return call('GET', '/drive/v1/files?folder_token=%s&page_size=200' % folder, tk).get('files', [])


def delete(tk, token, typ):
    try:
        call('DELETE', '/drive/v1/files/%s?type=%s' % (token, typ), tk)
    except RuntimeError as e:
        print('  删除旧版本失败（忽略）：', e, file=sys.stderr)


def share_public(tk, token, typ):
    # 获得链接的人可阅读（含组织外）；租户策略不允许外部访问时退回组织内可读
    for body in ({'external_access': True, 'link_share_entity': 'anyone_readable'},
                 {'link_share_entity': 'tenant_readable'}):
        try:
            call('PATCH', '/drive/v1/permissions/%s/public?type=%s' % (token, typ), tk, body)
            return body['link_share_entity']
        except RuntimeError as e:
            last = e
    print('  设置分享失败：', last, file=sys.stderr)
    return None


def upload_one(tk, folder, path, existing):
    name = path.name
    stem = path.stem
    for f in existing:
        if (f['type'] == 'file' and f['name'] == name) or (f['type'] == 'docx' and f['name'] == stem):
            delete(tk, f['token'], f['type'])
    content = path.read_bytes()
    body, ct = multipart({'file_name': name, 'parent_type': 'explorer', 'parent_node': folder, 'size': str(len(content))},
                         'file', name, content)
    ftoken = call('POST', '/drive/v1/files/upload_all', tk, raw=body, ctype=ct)['file_token']
    # 导入为在线文档
    body, ct = multipart({'file_name': name, 'parent_type': 'ccm_import_open', 'size': str(len(content)),
                          'extra': json.dumps({'obj_type': 'docx', 'file_extension': 'docx'})}, 'file', name, content)
    mtoken = call('POST', '/drive/v1/medias/upload_all', tk, raw=body, ctype=ct)['file_token']
    ticket = call('POST', '/drive/v1/import_tasks', tk, {
        'file_extension': 'docx', 'file_token': mtoken, 'type': 'docx', 'file_name': stem,
        'point': {'mount_type': 1, 'mount_key': folder}})['ticket']
    doc = None
    for _ in range(60):
        time.sleep(2)
        res = call('GET', '/drive/v1/import_tasks/' + ticket, tk)['result']
        if res.get('job_status') == 0:
            doc = res
            break
        if res.get('job_status') not in (1, 2):
            raise RuntimeError('导入失败：%s' % res)
    if not doc:
        raise RuntimeError('导入超时')
    s1 = share_public(tk, ftoken, 'file')
    s2 = share_public(tk, doc['token'], 'docx')
    return {'name': name, 'file_token': ftoken, 'file_url': 'https://jcnrfbqy4a7j.feishu.cn/file/' + ftoken,
            'doc_token': doc['token'], 'doc_url': doc.get('url'), 'share': [s1, s2]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--folder', required=True)
    ap.add_argument('files', nargs='+')
    a = ap.parse_args()
    tk = tenant_token()
    folder, furl = ensure_folder(tk, a.folder)
    share_public(tk, folder, 'folder')
    existing = list_folder(tk, folder)
    out = {'folder': a.folder, 'folder_url': furl, 'docs': []}
    for f in a.files:
        p = Path(f)
        print('上传', p.name, '…')
        r = upload_one(tk, folder, p, existing)
        print('  在线文档：', r['doc_url'])
        out['docs'].append(r)
    (ROOT / 'docs' / 'feishu-links.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
