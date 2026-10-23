#!/usr/bin/env python3
"""由验收数据生成《测试报告》《操作手册》的 Markdown，再交给 md2docx.py 转成宋体 Word。

数据来源（与验收进度表同一份）：
  docs/acceptance/items.json         合同条目 + 三级功能主表
  docs/acceptance/<模块>.json         页面、操作步骤、预期、接口、测试、工程实现说明
  docs/acceptance/unit-results.json  自动化测试结果（tools/acceptance.py 生成）
  docs/acceptance/e2e-results.json   浏览器操作验收结果（含截图路径）
  docs/acceptance/defects.md         缺陷清单（只统计条数）

用法：
  python3 tools/acceptance.py            # 先刷新 unit-results.json
  python3 tools/gen_docs.py              # 生成 docs/test/测试报告.md、docs/manual/操作手册.md 及对应 .docx
"""
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ACC = ROOT / 'docs' / 'acceptance'
SGT = dt.timezone(dt.timedelta(hours=8))
VERSION = 'V1.2.0'
PROJECT = '2026年AI+稀土追溯模型关键技术及应用研究(隐私计算)联合研发项目'
SYSTEM = '隐私计算联邦学习软件原型'
CONSOLE_URL = 'https://share.drluo.cn/share/privacy-console-1014-08675d/'

MODULES = [('FL', '联邦学习'), ('HE', '同态加密'), ('MPC', '多方安全计算'), ('PSI', '隐私求交'), ('DP', '差分隐私')]


def load(p, default=None):
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default


def cell(s):
    return str(s or '').replace('|', '\\|').replace('\n', ' ')


def data():
    master = load(ACC / 'items.json')
    impl = {}
    for p in sorted(ACC.glob('*.json')):
        if p.name not in ('items.json', 'unit-results.json', 'e2e-results.json'):
            impl.update(load(p, {}))
    unit = load(ACC / 'unit-results.json', {'by_id': {}, 'total': 0, 'failed': 0})
    e2e = load(ACC / 'e2e-results.json', {'by_id': {}})
    defects = (ACC / 'defects.md').read_text(encoding='utf-8') if (ACC / 'defects.md').exists() else ''
    rows = []
    for it in master['items']:
        ut = unit['by_id'].get(it['id'], [])
        ev = e2e['by_id'].get(it['id'], {})
        u_ok = bool(ut) and all(t['pass'] for t in ut)
        rows.append(dict(it, impl=impl.get(it['id'], {}), unit=ut, e2e=ev,
                         passed=u_ok and bool(ev.get('pass'))))
    return master, rows, unit, e2e, defects


def contract_status(c, by):
    subs = [by[m] for m in c['maps']]
    if all(s['passed'] for s in subs):
        if c['id'] in ('T-01', 'T-02'):
            return '已完成（指标数值为原型内置评估引擎仿真结果）'
        return '已完成'
    bad = [s['id'] for s in subs if not s['passed']]
    return '部分完成（未通过：%s）' % '、'.join(bad)


# ------------------------------------------------------------------ 测试报告

def report_md(master, rows, unit, e2e, defects):
    by = {r['id']: r for r in rows}
    today = dt.datetime.now(SGT)
    passed = sum(r['passed'] for r in rows)
    v5 = [r for r in rows if r['source'] == 'V5']
    v5p = sum(r['passed'] for r in v5)
    cdone = sum(1 for c in master['contract'] if all(by[m]['passed'] for m in c['maps']))
    ndef = len(re.findall(r'^### D\d+', defects, re.M))
    e2e_cnt = sum(1 for r in rows if r['e2e'])
    L = []
    L += ['---', 'title: ' + PROJECT, 'subtitle: ' + SYSTEM + '测试报告', 'version: ' + VERSION,
          'date: %d 年 %d 月' % (today.year, today.month), 'org: 复旦大学', '---', '']
    L += ['# 1 概述', '',
          '本次测试验证%s（%s）能否满足项目合同《成果形式及验收要求》（附件 1）中隐私计算功能清单 16 项、技术参数指标 3 项的要求，'
          '并按甲方《自研功能清单 V5》对 60 个三级功能逐项核对；合同中有、V5 中未单列的 12 项能力作为合同补充项一并测试，共 %d 项。' % (
              SYSTEM, VERSION, len(rows)), '']
    L += ['## 1.1 测试依据', '',
          '1. 《2026年AI+稀土追溯模型关键技术及应用研究(隐私计算)联合研发项目成果形式及验收要求》（附件 1）。',
          '2. 《自研功能清单 V5》（甲方工程化拆解，60 个三级功能）。',
          '3. 《隐私计算联邦学习软件原型设计文档 V1.0》。',
          '4. 《隐私计算平台控制台后端接口文档 v1.2》（API.md）。', '']
    L += ['# 2 测试对象', '', '表 2-1 测试对象', '',
          '| 测试对象 | 组成 | 软件版本 | 运行环境 | 数量 |', '|---|---|---|---|---|',
          '| %s | 前端控制台（联邦学习、同态加密、多方安全计算、隐私求交、差分隐私五个模块，14 个二级功能页面）；与后端接口契约一致的内置服务（mock） | %s | Chrome 148 / Edge 等现代浏览器；Node.js 22（自动化测试） | 1 |' % (SYSTEM, VERSION), '']
    L += ['# 3 测试环境', '', '## 3.1 技术参数指标', '', '表 3-1 合同功能清单与技术参数指标', '',
          '| 编号 | 一级模块 | 二级模块 | 技术参数指标（合同原文） |', '|---|---|---|---|']
    for c in master['contract']:
        L.append('| %s | %s | %s | %s |' % (c['id'], cell(c['module']), cell(c['name']), cell(c['desc'])))
    L += ['', '## 3.2 测试仪表和工具', '', '表 3-2 测试工具', '',
          '| 序号 | 名称 | 用途 | 硬件配置 | 软件配置 | 数量 |', '|---|---|---|---|---|---|',
          '| 1 | 测试服务器 | 运行自动化测试与浏览器验收 | x86_64，Linux 5.15 | Node.js v22.22.0（node:test 测试框架） | 1 |',
          '| 2 | 浏览器验收工具 | 按操作步骤逐项点击验证并截图 | 同上 | Chrome 148（无头模式）+ agent-browser，视口 1440 × 900 | 1 |',
          '| 3 | 演示环境 | 公网访问控制台 | 云服务器（nginx 静态服务） | %s | 1 |' % CONSOLE_URL, '']
    L += ['# 4 测试安排', '', '表 4-1 测试时间和人员安排', '',
          '| 测试时间 | 测试地点 | 主要测试内容 |', '|---|---|---|',
          '| %s | 复旦大学 | 72 个三级功能自动化测试与浏览器操作验收；合同 16 项功能与 3 项技术参数指标对照 |' % today.strftime('%Y.%m.%d'), '']
    L += ['# 5 测试内容', '',
          '每个三级功能同时做两类测试：（1）自动化测试：调用接口验证正常流程和至少一个异常流程（参数越界、非法状态、重复提交等），测试用例名以功能编号开头；'
          '（2）浏览器操作验收：按操作手册步骤在页面上实际操作，核对预期结果并截图留证。两类测试都通过，该项判定为通过。', '']
    L += ['## 5.1 功能性指标完成情况', '', '表 5-1 合同条目完成情况', '',
          '| 编号 | 系统名称 | 功能模块 | 二级模块（技术参数指标见表 3-1） | 对应三级功能 | 完成情况 |', '|---|---|---|---|---|---|']
    for c in master['contract']:
        L.append('| %s | %s | %s | %s | %s | %s |' % (c['id'], SYSTEM, cell(c['module']), cell(c['name']),
                                                  '、'.join(c['maps']), contract_status(c, by)))
    L += ['', '## 5.2 三级功能测试明细', '', '表 5-2 三级功能测试结果', '',
          '| 编号 | 一级功能 | 二级功能 | 三级功能 | 来源 | 自动化测试（通过 / 用例数） | 浏览器操作验收 | 结果 |',
          '|---|---|---|---|---|---|---|---|']
    for r in rows:
        ev = r['e2e']
        L.append('| %s | %s | %s | %s | %s | %d / %d | %s | %s |' % (
            r['id'], r['l1'], r['l2'], cell(r['l3']), '清单 V5' if r['source'] == 'V5' else '合同补充',
            sum(t['pass'] for t in r['unit']), len(r['unit']),
            ('通过' if ev.get('pass') else '未通过') if ev else '未执行', '通过' if r['passed'] else '未通过'))
    L += ['', '## 5.3 测试用例清单', '',
          '自动化测试用例共 %d 个（最近一次运行：%s，失败 %d 个）。按功能编号列出如下。' % (
              unit['total'], unit.get('ran_at', '').replace('T', ' ')[:16] + ' SGT', unit['failed']), '',
          '| 编号 | 测试用例 | 结果 |', '|---|---|---|']
    for r in rows:
        for t in r['unit']:
            L.append('| %s | %s | %s |' % (r['id'], cell(re.sub(r'^(\[[A-Z]+-[A-Z]+-\d{2}\])+\s*', '', t['name'])),
                                         '通过' if t['pass'] else '未通过'))
    L += ['', '## 5.4 技术参数指标的评估口径', '',
          '1. 梯度重构攻击成功率（T-01）：在稀土氧化物（Nd₂O₃、CeO₂、La₂O₃）日度价格时序数据集、1 个服务端 + 3 个客户端架构下，截获客户端上传的梯度后运行 DLG、iDLG 攻击；还原样本与原始样本的均方误差（MSE）不超过 0.0025 记为还原成功，成功率 = 还原成功样本数 / 攻击样本数。合同要求不超过 5%。',
          '2. 通信压缩比（T-01）：压缩比 = FedAvg 单轮平均通信数据总量 / 本算法单轮平均通信数据总量，合同要求不低于 6。',
          '3. 联邦训练精度衰减（T-02）：同等模型结构与参数下，集中式明文训练 Accuracy 与联邦（含隐私保护）训练 Accuracy 之差，以百分点计，合同要求不超过 3。',
          '4. 上述三项在「联邦学习 / 技术指标验证」页面执行，当前数值来自原型内置评估引擎的仿真结果。', '']
    L += ['# 6 测试结论', '',
          '本次测试覆盖联邦学习、同态加密、多方安全计算、隐私求交、差分隐私五个模块的 %d 个三级功能（自研功能清单 V5 %d 项、合同补充 %d 项），'
          '执行自动化测试用例 %d 个、浏览器操作验收 %d 项。测试通过 %d 项，其中清单 V5 通过 %d / %d 项；'
          '合同功能清单与技术参数指标共 19 条，全部子项通过的 %d 条。测试过程中共发现缺陷 %d 个，修复与复测情况见缺陷清单。' % (
              len(rows), len(v5), len(rows) - len(v5), unit['total'], e2e_cnt, passed, v5p, len(v5), cdone, ndef), '',
          '具体操作流程详见附件《%s操作手册》。' % SYSTEM, '']
    return '\n'.join(L)


# ------------------------------------------------------------------ 操作手册

def manual_md(master, rows):
    today = dt.datetime.now(SGT)
    L = ['---', 'title: ' + PROJECT, 'subtitle: ' + SYSTEM + '操作手册', 'version: ' + VERSION,
         'date: %d 年 %d 月' % (today.year, today.month), 'org: 复旦大学', '---', '']
    L += ['# 1 引言', '',
          '本手册说明%s各功能的操作方法，供使用人员和测试人员按步骤操作和验收。每个功能给出功能编号、功能说明、操作步骤、预期结果和界面截图，'
          '功能编号与《测试报告》《验收进度表》一致。' % SYSTEM, '']
    L += ['# 2 运行环境与访问', '',
          '1. 浏览器：Chrome、Edge 等现代浏览器，建议分辨率 1440 × 900 及以上。',
          '2. 访问地址：%s' % CONSOLE_URL,
          '3. 顶栏「当前项目」下拉切换联邦项目；左侧为能力模块导航，点击一级模块展开二级功能。',
          '4. 演示数据保存在当前浏览器中，刷新页面不会丢失；左下角「重置演示数据」可恢复到初始状态。', '']
    overview = ROOT / 'docs' / 'manual' / 'img' / 'FL-PROC-06.png'
    L += ['# 3 界面总览', '', '系统界面由顶栏、侧边导航和工作区三部分组成：顶栏显示平台名称、当前项目和运行环境；侧边导航按五个能力模块组织，'
          '每个模块下拉出二级功能；工作区显示所选功能页面。', '']
    if overview.exists():
        L += ['![图 3-1 系统界面总览](img/FL-PROC-06.png)', '']
    ch = 4
    for code, name in MODULES:
        mrows = [r for r in rows if r['id'].startswith(code + '-')]
        if not mrows:
            continue
        L += ['# %d %s' % (ch, name), '']
        sec = 0
        fig = 0
        for l2 in dict.fromkeys(r['l2'] for r in mrows):
            sec += 1
            subs = [r for r in mrows if r['l2'] == l2]
            L += ['## %d.%d %s' % (ch, sec, l2), '',
                  '页面入口：左侧导航「%s」→「%s」。' % (name, l2), '']
            for k, r in enumerate(subs, 1):
                im = r['impl']
                L += ['### %d.%d.%d %s（%s）' % (ch, sec, k, r['l3'], r['id']), '']
                L += ['功能说明：%s' % r['desc'], '']
                if im.get('ui'):
                    L += ['界面位置：%s' % im['ui'], '']
                steps = im.get('steps') or []
                if steps:
                    L += ['操作步骤：', '']
                    L += ['%d. %s' % (i, s) for i, s in enumerate(steps, 1)]
                    L += ['']
                if im.get('expected'):
                    L += ['预期结果：%s' % im['expected'], '']
                for shot in (r['e2e'].get('screens') or []):
                    p = ROOT / shot
                    if p.exists():
                        fig += 1
                        L += ['![图 %d-%d %s](img/%s)' % (ch, fig, r['l3'], p.name), '']
        ch += 1
    L += ['# %d 常见提示与处理' % ch, '',
          '| 提示码 | 含义 | 处理方法 |', '|---|---|---|',
          '| 40000 | 参数不合法（必填项缺失、组合不支持等） | 按弹窗提示修改输入后重新提交 |',
          '| 40001 | 所选加密方案不支持该运算 | 换用支持该运算的方案，例如密文乘密文选 CKKS / BGV |',
          '| 40002 | 数值格式错误 | 输入合法数字 |',
          '| 40003 | 数值超出允许范围 | 按提示的范围调整 |',
          '| 40400 / 40402 | 对象不存在 / 密钥已销毁或过期 | 刷新列表或重新生成密钥 |',
          '| 40901 | 当前状态不允许该操作（如训练中修改配置） | 等任务暂停或结束后再操作 |',
          '| 40902 | 名称重复 | 换一个名称 |',
          '| 42201 | 连通性检查失败（节点离线、数据源不可达） | 检查节点或数据源状态后重试 |', '']
    return '\n'.join(L)


def build(md_text, md_path, docx_path):
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(md_text, encoding='utf-8')
    subprocess.run([sys.executable, str(ROOT / 'tools' / 'md2docx.py'), str(md_path), str(docx_path)], check=True)
    print('→', md_path.relative_to(ROOT), '/', docx_path.relative_to(ROOT))


def main():
    master, rows, unit, e2e, defects = data()
    build(report_md(master, rows, unit, e2e, defects), ROOT / 'docs' / 'test' / '测试报告.md',
          ROOT / 'docs' / 'test' / (SYSTEM + '_测试报告_' + VERSION + '.docx'))
    build(manual_md(master, rows), ROOT / 'docs' / 'manual' / '操作手册.md',
          ROOT / 'docs' / 'manual' / (SYSTEM + '_操作手册_' + VERSION + '.docx'))


if __name__ == '__main__':
    main()
