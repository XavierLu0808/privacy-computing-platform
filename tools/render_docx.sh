#!/bin/bash
# docx -> 更新目录页码 -> docx + pdf（+ 逐页 png）
#
# 用法：tools/render_docx.sh 文档.docx [输出目录] [--png]
#   - 经 ssh 到宿主机，在 docker 镜像 lo-render（LibreOffice + python-uno + 中文字体）里
#     打开文档、更新目录、导出 PDF；目录条目与页码写回原 docx 的 TOC 域结果（域保留，Word 里仍可右键更新）。
#   - 输出目录默认 <文档名>_render/：in.pdf（最终文档的渲染）、toc.json，加 --png 时另有 pg-NN.png（70 dpi）。
#   - 原 docx 被就地更新。流程：LibreOffice 更新目录 -> 写入 docx -> 渲染写入后的文档 -> 按实际页码校正 -> 再渲染终稿。
#   - 首次使用先在宿主机构建镜像：docker build -t lo-render -f tools/lo-render.Dockerfile tools/
#   - 宿主机默认 lmy@127.0.0.1，可用环境变量 LO_HOST 覆盖。
# 注意：渲染机没有真正的宋体，PDF 里用替代字体，页码与 Word 里可能差一两页；在 Word 中右键更新域后以 Word 为准。
set -e
DOCX="$(readlink -f "$1")"; OUT="${DOCX%.docx}_render"; PNG=""
for a in "${@:2}"; do [ "$a" = "--png" ] && PNG=1 || OUT="$(readlink -f "$a")"; done
HOST="${LO_HOST:-lmy@127.0.0.1}"
TOOLS="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

# render <docx> <update:1|0> <png:1|0>：在容器里渲染，结果落到 $OUT/_r/（in.pdf、toc.json、pg-*.png）
render() {
  local W=/tmp/lo-work-$$ extra=""
  [ "$3" = 1 ] && extra="&& pdftoppm -r 70 -png out/in.pdf out/pg"
  ssh -o BatchMode=yes $HOST "rm -rf $W; mkdir -p $W"
  scp -q -o BatchMode=yes "$1" $HOST:$W/in.docx
  scp -q -o BatchMode=yes "$TOOLS/lo_update_toc.py" $HOST:$W/
  ssh -o BatchMode=yes $HOST "chmod -R 777 $W; docker run --rm --user \$(id -u):\$(id -g) -e HOME=/tmp $( [ "$2" = 0 ] && echo '-e NO_UPDATE=1' ) -v $W:/w lo-render sh -c 'cd /w && python3 lo_update_toc.py in.docx out && pdfinfo out/in.pdf | grep Pages $extra'"
  rm -rf "$OUT/_r"; mkdir -p "$OUT/_r"
  scp -q -o BatchMode=yes "$HOST:$W/out/*" "$OUT/_r/"
  ssh -o BatchMode=yes $HOST "rm -rf $W"
}

cp "$DOCX" "$DOCX.bak"
render "$DOCX.bak" 1 0                                   # 1) LibreOffice 更新目录，取条目与页码
cp "$OUT/_r/toc.json" "$OUT/toc.json"
python3 "$TOOLS/inject_toc.py" "$DOCX.bak" "$OUT/toc.json" "$DOCX"
render "$DOCX" 0 0                                       # 2) 渲染写入目录后的文档（不再更新）
python3 "$TOOLS/inject_toc.py" "$DOCX.bak" "$OUT/toc.json" "$DOCX" --calibrate "$OUT/_r/in.pdf"
render "$DOCX" 0 "${PNG:-0}"                             # 3) 渲染终稿
cp "$OUT/_r/in.pdf" "$OUT/in.pdf"
[ -n "$PNG" ] && { rm -f "$OUT"/pg-*.png; cp "$OUT"/_r/pg-*.png "$OUT/"; }
rm -rf "$OUT/_r" "$DOCX.bak"
echo "完成：$DOCX（目录已更新），$OUT/in.pdf"
