#!/bin/bash
# setup_studio.sh — Studio 上一键初始化 vision daemon 环境
#
# 用法: bash tools/vision/setup_studio.sh
# 需要在 mycc-brain 根目录执行

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VISION_DIR="$SCRIPT_DIR"
MODELS_DIR="$VISION_DIR/models"
VENV_DIR="$VISION_DIR/.venv-vision"

# Python 路径（Studio 上 brew python3.12，symlink 可能断）
PYTHON_CANDIDATES=(
  "python3"
  "python3.12"
  "/opt/homebrew/bin/python3.12"
  "/opt/homebrew/Cellar/python@3.12/3.12.13/libexec/bin/python3"
)

echo "=== mycc-brain vision daemon 环境初始化 ==="
echo "Brain root: $BRAIN_ROOT"
echo "Vision dir: $VISION_DIR"

# ── 1. 找到可用的 Python ──
PYTHON=""
for candidate in "${PYTHON_CANDIDATES[@]}"; do
  if command -v "$candidate" &>/dev/null || [ -x "$candidate" ]; then
    PYTHON="$candidate"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "ERROR: 找不到 Python 3.12。请确认 brew python@3.12 已安装。"
  echo "  brew install python@3.12"
  exit 1
fi

echo "Python: $PYTHON ($($PYTHON --version 2>&1))"

# ── 2. 修复 python3.12 symlink（Studio 已知问题）──
BREW_PYTHON_OPT="/opt/homebrew/opt/python@3.12/bin"
BREW_PYTHON_CELLAR="/opt/homebrew/Cellar/python@3.12/3.12.13/bin/python3.12"
if [ -d "/opt/homebrew/opt/python@3.12" ] && [ ! -e "$BREW_PYTHON_OPT/python3.12" ]; then
  echo "修复 python3.12 symlink..."
  mkdir -p "$BREW_PYTHON_OPT"
  ln -sf "$BREW_PYTHON_CELLAR" "$BREW_PYTHON_OPT/python3.12" 2>/dev/null || true
fi

# ── 3. 创建 venv ──
if [ -d "$VENV_DIR" ]; then
  echo "venv 已存在: $VENV_DIR"
else
  echo "创建 venv: $VENV_DIR"
  $PYTHON -m venv "$VENV_DIR" || {
    echo "venv 创建失败，尝试 --without-pip..."
    $PYTHON -m venv --without-pip "$VENV_DIR"
    # 手动安装 pip
    "$VENV_DIR/bin/python3" -c "
import urllib.request, os, tempfile
url = 'https://bootstrap.pypa.io/get-pip.py'
fd, path = tempfile.mkstemp(suffix='.py')
urllib.request.urlretrieve(url, path)
os.system(f'{\"$VENV_DIR/bin/python3\"} {path}')
os.unlink(path)
"
  }
fi

VPYTHON="$VENV_DIR/bin/python3"
VPIP="$VENV_DIR/bin/pip"

# ── 4. 安装依赖 ──
echo "安装 Python 依赖..."
$VPIP install --upgrade pip -q
$VPIP install -r "$VISION_DIR/requirements.txt" -q
echo "依赖安装完成。"

# ── 5. 下载 MobileNet-SSD 模型 ──
mkdir -p "$MODELS_DIR"

PROTOTXT="$MODELS_DIR/MobileNetSSD_deploy.prototxt"
CAFFEMODEL="$MODELS_DIR/MobileNetSSD_deploy.caffemodel"

PROTOTXT_URL="https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/MobileNetSSD_deploy.prototxt"
CAFFEMODEL_URL="https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/MobileNetSSD_deploy.caffemodel"

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

# ── 6. 自检 ──
echo ""
echo "=== 自检 ==="

$VPYTHON -c "import cv2; print(f'OpenCV: {cv2.__version__}')" || {
  echo "ERROR: import cv2 失败"
  exit 1
}

$VPYTHON -c "import numpy; print(f'NumPy: {numpy.__version__}')" || {
  echo "ERROR: import numpy 失败"
  exit 1
}

$VPYTHON -c "
import cv2
net = cv2.dnn.readNetFromCaffe(
    '$PROTOTXT',
    '$CAFFEMODEL'
)
print(f'MobileNet-SSD 加载成功')
" || {
  echo "ERROR: MobileNet-SSD 加载失败"
  exit 1
}

echo ""
echo "=== 初始化完成 ==="
echo "启动 daemon: $VPYTHON $VISION_DIR/vision_daemon.py"
echo "或使用 PM2:  bash $VISION_DIR/run_vision.sh"
