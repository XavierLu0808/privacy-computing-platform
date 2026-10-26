# 文档索引

当前运行方式、鉴权和部署入口以[根 README](../README.md)为准；页面开发以[开发约定](DEV-CONVENTIONS.md)为准。完整接口约定集中在根目录 [API.md](../API.md)。

## 保留的源资料

- `acceptance/items.json`：固定需求编号和合同映射。
- `acceptance/*.json` 模块文件：早期实现与操作映射，包含旧测试文件名和 Mock 设计，使用前需按当前客户端与真实后端重新核验。`status: done` 不是当前验收结论。
- `acceptance/` 中的原始 DOCX/XLSX：需求与验收依据，保留原件。
- `api/*.md`：汇总到 API.md 前的模块设计片段，含早期 Mock 行为说明；不能作为现行服务的运行说明。
- `design/设计文档.md`：早期原型设计源稿，保留供需求追溯。关于 Mock、演示数据、测试数量和启动方法的内容已过时。

旧 Mock 浏览器结果、截图、操作手册、测试报告与重复 Word 导出已经移除；可从清理前的 Git 历史查阅。早期原始版本见提交 `6578ca3`，真实后端连接改造版本见 `7004181`。当前浏览器证据应独立生成，并绑定当前源码摘要。

## 生成资料

证据汇总使用 `tools/acceptance.py`，推荐输出到 `output/acceptance/`，详见根 README。文档转换工具保留用于整理需求映射：

```sh
# 在独立虚拟环境中安装可选依赖
python3 -m venv .venv
.venv/bin/python -m pip install python-docx openpyxl

# 生成当前源码对应的测试结果，再生成文档草稿
.venv/bin/python tools/acceptance.py
.venv/bin/python tools/gen_docs.py
```

生成的 Markdown 和 Word 位于 `output/documents/`，由 Git 忽略。文档生成器读取 `docs/acceptance/unit-results.json` 和可选的 `e2e-results.json`；只有摘要匹配、范围正确的结果才可使用。资料中的历史实现映射仍需人工核验，生成文档不代表完成端到端或合同验收。

单独转换现有 Markdown：

```sh
.venv/bin/python tools/md2docx.py input.md output/documents/result.docx
.venv/bin/python -m unittest tools/test_md2docx.py -v
```
