#!/bin/sh
# Open, Open Recent, and Make. See harness/ui.py.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "$GNW_PYTHON" ]; then
    PY=$GNW_PYTHON
elif [ -x "$ROOT/.venv/bin/python" ]; then
    PY=$ROOT/.venv/bin/python
else
    PY=python3
fi
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
exec "$PY" -m harness.ui "$@"
