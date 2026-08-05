#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "venv" ]; then
  echo "[vp-service] Creating Python virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate

echo "[vp-service] Installing/updating dependencies (using Tsinghua mirror)..."
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --upgrade pip
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

export MODELSCOPE_CACHE="${MODELSCOPE_CACHE:-$SCRIPT_DIR/models}"
export HF_HOME="${HF_HOME:-$SCRIPT_DIR/models/huggingface}"
mkdir -p "$MODELSCOPE_CACHE" "$HF_HOME"

echo "[vp-service] Starting voiceprint service on http://0.0.0.0:${VP_PORT:-8001}"
exec python app.py
