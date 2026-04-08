#!/bin/bash
# setup_studio.sh — Studio 上一键初始化 vision daemon 环境
#
# 用法: bash tools/vision/setup_studio.sh
# 需要在 mycc-brain 根目录执行

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VISION_DIR="$SCRIPT_DIR"
MODELS_DIR="$VISION_DIR/models"
VENV_DIR="$VISION_DIR/.venv-vision"

find_python312() {
  local candidates=()
  candidates+=("python3.12")
  candidates+=("/opt/homebrew/bin/python3.12")

  if command -v brew >/dev/null 2>&1; then
    local brew_prefix cellar_dir
    brew_prefix="$(brew --prefix python@3.12 2>/dev/null || true)"
    cellar_dir="$(brew --cellar python@3.12 2>/dev/null || true)"

    if [ -n "$brew_prefix" ]; then
      candidates+=("$brew_prefix/bin/python3.12")
    fi

    if [ -n "$cellar_dir" ] && [ -d "$cellar_dir" ]; then
      for bin_path in "$cellar_dir"/*/bin/python3.12; do
        [ -e "$bin_path" ] && candidates+=("$bin_path")
      done
    fi
  fi

  candidates+=("python3")

  local candidate version
  for candidate in "${candidates[@]}"; do
    if ! command -v "$candidate" >/dev/null 2>&1 && [ ! -x "$candidate" ]; then
      continue
    fi
    version="$("$candidate" --version 2>&1 || true)"
    if printf '%s\n' "$version" | grep -q '^Python 3\.12\.'; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

repair_python_symlink() {
  if ! command -v brew >/dev/null 2>&1; then
    return 0
  fi

  local brew_prefix cellar_dir target_dir latest_bin
  brew_prefix="$(brew --prefix python@3.12 2>/dev/null || true)"
  cellar_dir="$(brew --cellar python@3.12 2>/dev/null || true)"

  if [ -z "$brew_prefix" ] || [ -z "$cellar_dir" ] || [ ! -d "$cellar_dir" ]; then
    return 0
  fi

  target_dir="$brew_prefix/bin"
  mkdir -p "$target_dir"

  latest_bin=""
  for bin_path in "$cellar_dir"/*/bin/python3.12; do
    if [ -e "$bin_path" ]; then
      latest_bin="$bin_path"
    fi
  done
  if [ -n "$latest_bin" ] && [ ! -e "$target_dir/python3.12" ]; then
    ln -sf "$latest_bin" "$target_dir/python3.12"
    echo "已修复 python3.12 symlink -> $latest_bin"
  fi
}

echo "=== mycc-brain vision daemon 环境初始化 ==="
echo "Brain root: $BRAIN_ROOT"
echo "Vision dir: $VISION_DIR"

repair_python_symlink

PYTHON="$(find_python312 || true)"
if [ -z "${PYTHON:-}" ]; then
  echo "ERROR: 找不到 Python 3.12。请确认 brew python@3.12 已安装。"
  echo "  brew install python@3.12"
  exit 1
fi

echo "Python: $PYTHON ($($PYTHON --version 2>&1))"

if ! "$PYTHON" - <<'PY'
import sys
major, minor = sys.version_info[:2]
raise SystemExit(0 if (major, minor) == (3, 12) else 1)
PY
then
  echo "ERROR: 选中的 Python 不是 3.12"
  exit 1
fi

# ── 1. 创建 venv ──
if [ -d "$VENV_DIR" ]; then
  echo "venv 已存在: $VENV_DIR"
else
  echo "创建 venv: $VENV_DIR"
  if ! "$PYTHON" -m venv "$VENV_DIR"; then
    echo "venv 创建失败，尝试 --without-pip..."
    "$PYTHON" -m venv --without-pip "$VENV_DIR"
    "$VENV_DIR/bin/python3" -m ensurepip --upgrade
  fi
fi

VPYTHON="$VENV_DIR/bin/python3"
VPIP="$VENV_DIR/bin/pip"

if [ ! -x "$VPIP" ]; then
  "$VPYTHON" -m ensurepip --upgrade
fi

# ── 2. 安装依赖 ──
echo "安装 Python 依赖..."
"$VPIP" install --upgrade pip -q
"$VPIP" install -r "$VISION_DIR/requirements.txt" -q
echo "依赖安装完成。"

# ── 3. 下载 MobileNet-SSD 模型 ──
mkdir -p "$MODELS_DIR"

PROTOTXT="$MODELS_DIR/MobileNetSSD_deploy.prototxt"
CAFFEMODEL="$MODELS_DIR/MobileNetSSD_deploy.caffemodel"

MODEL_COMMIT="97406996b1eee2d40eb0a00ae567cf41e23369f9"
PROTOTXT_URL="https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/${MODEL_COMMIT}/deploy.prototxt"
CAFFEMODEL_URL="https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/${MODEL_COMMIT}/mobilenet_iter_73000.caffemodel"

if [ ! -f "$PROTOTXT" ]; then
  echo "下载 MobileNetSSD_deploy.prototxt..."
  curl -fSL "$PROTOTXT_URL" -o "$PROTOTXT" || {
    echo "ERROR: prototxt 下载失败。请手动下载到 $PROTOTXT"
    exit 1
  }
else
  echo "prototxt 已存在。"
fi

if [ ! -f "$CAFFEMODEL" ]; then
  echo "下载 MobileNetSSD_deploy.caffemodel (~23MB)..."
  curl -fSL "$CAFFEMODEL_URL" -o "$CAFFEMODEL" || {
    echo "ERROR: caffemodel 下载失败。请手动下载到 $CAFFEMODEL"
    exit 1
  }
else
  echo "caffemodel 已存在。"
fi

# ── 4. 自检 ──
echo ""
echo "=== 自检 ==="

"$VPYTHON" -c "import cv2; print(f'OpenCV: {cv2.__version__}')" || {
  echo "ERROR: import cv2 失败"
  exit 1
}

"$VPYTHON" -c "import numpy; print(f'NumPy: {numpy.__version__}')" || {
  echo "ERROR: import numpy 失败"
  exit 1
}

"$VPYTHON" -c "import sounddevice as sd; print(f'sounddevice: {sd.__version__}')" || {
  echo "ERROR: import sounddevice 失败"
  exit 1
}

"$VPYTHON" - <<PY || {
import cv2
net = cv2.dnn.readNetFromCaffe(
    "$PROTOTXT",
    "$CAFFEMODEL",
)
print("MobileNet-SSD 加载成功")
PY
  echo "ERROR: MobileNet-SSD 加载失败"
  exit 1
}

"$VPYTHON" - <<'PY'
import sounddevice as sd
try:
    dev = sd.query_devices(kind="input")
    name = dev.get("name", "unknown") if isinstance(dev, dict) else str(dev)
    print(f"默认输入设备: {name}")
except Exception as exc:
    print(f"WARN: 输入设备检查跳过: {exc}")
PY

echo ""
echo "=== 初始化完成 ==="
echo "启动 daemon: $VPYTHON $VISION_DIR/vision_daemon.py"
echo "或使用 PM2:  bash $VISION_DIR/run_vision.sh --pm2"
