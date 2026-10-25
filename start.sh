#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -n "${SFL_FRONTEND_PYTHON:-}" ]; then
  python="$SFL_FRONTEND_PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  python="$(command -v python3)"
elif [ -x /opt/homebrew/bin/python3 ]; then
  python=/opt/homebrew/bin/python3
else
  printf '%s\n' '需要 Python 3.9 或更新版本；可用 SFL_FRONTEND_PYTHON 指定解释器。' >&2
  exit 1
fi
exec "$python" scripts/serve.py "$@"
