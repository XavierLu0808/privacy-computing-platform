#!/usr/bin/env python3
"""在 lo-render 容器里运行：用 LibreOffice 打开 docx，更新全部目录（两遍，保证页码稳定），
导出 PDF，并把目录条目写成 JSON。

用法（容器内）：python3 lo_update_toc.py 输入.docx 输出目录
输出：<输出目录>/toc.json（[[级别, 标题, 页码], ...]）、<输出目录>/in.pdf
"""
import json
import os
import subprocess
import sys
import time

import uno
from com.sun.star.beans import PropertyValue


def pv(name, value):
    p = PropertyValue()
    p.Name, p.Value = name, value
    return p


def connect(port=2002, tries=60):
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    for _ in range(tries):
        try:
            return resolver.resolve('uno:socket,host=localhost,port=%d;urp;StarOffice.ComponentContext' % port)
        except Exception:
            time.sleep(1)
    raise RuntimeError('连不上 soffice')


def main(src, outdir):
    os.makedirs(outdir, exist_ok=True)
    proc = subprocess.Popen(['soffice', '--headless', '--invisible', '--norestore', '-env:UserInstallation=file:///tmp/lo-profile',
                             '--accept=socket,host=localhost,port=2002;urp;'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ctx = connect()
        desktop = ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', ctx)
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(src)), '_blank', 0,
                                           (pv('Hidden', True),))
        for _ in range(0 if os.environ.get('NO_UPDATE') else 2):
            idx = doc.getDocumentIndexes()
            for i in range(idx.getCount()):
                idx.getByIndex(i).update()
            doc.refresh()
        entries = []
        idx = doc.getDocumentIndexes()
        for i in range(idx.getCount()):
            enum = idx.getByIndex(i).getAnchor().createEnumeration()
            while enum.hasMoreElements():
                par = enum.nextElement()
                if not hasattr(par, 'getString'):
                    continue
                style = par.ParaStyleName
                text = par.getString()
                if not style.startswith('Contents ') or '\t' not in text:
                    continue
                title, page = text.rsplit('\t', 1)
                entries.append([int(style.split()[-1]), title.strip(), page.strip()])
        with open(os.path.join(outdir, 'toc.json'), 'w', encoding='utf-8') as f:
            json.dump(entries, f, ensure_ascii=False)
        doc.storeToURL(uno.systemPathToFileUrl(os.path.abspath(os.path.join(outdir, 'in.pdf'))),
                       (pv('FilterName', 'writer_pdf_Export'),))
        doc.close(True)
        print('目录条目', len(entries))
    finally:
        try:
            desktop.terminate()
        except Exception:
            pass
        time.sleep(1)
        proc.kill()


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
