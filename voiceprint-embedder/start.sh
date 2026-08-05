#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT=8002
TSINGHUA_PIP="https://pypi.tuna.tsinghua.edu.cn/simple"
COMFY_WHEELS="/data/projects/ComfyUI_Env/wheels"

echo "===== Voiceprint Embedder (CAM++) Service ====="
echo "Deploy dir: $SCRIPT_DIR"
echo "Port: $PORT"
echo ""

if [ ! -d "venv" ]; then
    echo "[1/4] Creating Python virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

echo "[2/4] Installing PyTorch (CUDA 12.1, offline wheel from ComfyUI)..."
if [ -f "$COMFY_WHEELS/torch-2.5.1+cu121-cp310-cp310-linux_x86_64.whl" ]; then
    pip install "$COMFY_WHEELS/torch-2.5.1+cu121-cp310-cp310-linux_x86_64.whl"
    pip install "$COMFY_WHEELS/torchaudio-2.5.1+cu121-cp310-cp310-linux_x86_64.whl"
else
    echo "WARNING: Offline wheels not found, falling back to PyTorch cu121 index..."
    pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
fi

echo "[3/4] Verifying CUDA availability..."
python3 -c "
import torch
print(f'  torch: {torch.__version__}')
print(f'  cuda available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'  GPU: {torch.cuda.get_device_name(0)}')
    print(f'  VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB')
"

echo ""
echo "Installing other dependencies (Tsinghua mirror)..."
pip install --upgrade pip -i "$TSINGHUA_PIP"
pip install fastapi 'uvicorn[standard]' numpy soundfile librosa modelscope scipy -i "$TSINGHUA_PIP"

export MODELSCOPE_CACHE="$SCRIPT_DIR/models"
mkdir -p "$MODELSCOPE_CACHE"
echo ""
echo "Model cache dir: $MODELSCOPE_CACHE"
echo "[4/4] Starting uvicorn on 0.0.0.0:$PORT ..."
echo ""

exec uvicorn app:app \
    --host 0.0.0.0 \
    --port $PORT \
    --workers 1 \
    --log-level info
