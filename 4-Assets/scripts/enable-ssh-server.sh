#!/usr/bin/env bash
# enable-ssh-server.sh
# 用途：在新装 Linux 上一键安装并开启 OpenSSH 服务，方便局域网 ssh 连接
# 用法：
#   1. 拷到目标机任意目录（U 盘 / 下载）
#   2. bash enable-ssh-server.sh
#   3. 按提示输入本机 sudo 密码
# 说明：不修改密码、不改 sshd 安全策略，只做「能连上」最小集

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $*"; }
fail()  { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

echo "========================================"
echo "  OpenSSH 一键安装 / 开启脚本"
echo "========================================"
echo

# 必须 root 或能 sudo
if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    fail "没有 sudo，也不是 root。请用 root 执行：su - 后再 bash $0"
  fi
  SUDO="sudo"
  echo "接下来可能要求输入当前用户的 sudo 密码（本机密码，不是远程密码）"
  $SUDO -v || fail "sudo 鉴权失败"
fi

# 检测发行版
ID="unknown"
ID_LIKE=""
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
info "系统: ${PRETTY_NAME:-$ID}"

install_pkg() {
  case "${ID}" in
    ubuntu|debian|linuxmint|pop|raspbian|elementary)
      $SUDO apt-get update -y
      $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server
      SERVICE_NAME="ssh"
      ;;
    fedora|rhel|centos|rocky|almalinux|ol)
      if command -v dnf >/dev/null 2>&1; then
        $SUDO dnf install -y openssh-server
      else
        $SUDO yum install -y openssh-server
      fi
      SERVICE_NAME="sshd"
      ;;
    arch|manjaro|endeavouros)
      $SUDO pacman -Sy --noconfirm openssh
      SERVICE_NAME="sshd"
      ;;
    opensuse*|sles)
      $SUDO zypper --non-interactive install openssh
      SERVICE_NAME="sshd"
      ;;
    *)
      # 兜底：按包管理器猜
      if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update -y
        $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server
        SERVICE_NAME="ssh"
      elif command -v dnf >/dev/null 2>&1; then
        $SUDO dnf install -y openssh-server
        SERVICE_NAME="sshd"
      elif command -v yum >/dev/null 2>&1; then
        $SUDO yum install -y openssh-server
        SERVICE_NAME="sshd"
      elif command -v pacman >/dev/null 2>&1; then
        $SUDO pacman -Sy --noconfirm openssh
        SERVICE_NAME="sshd"
      else
        fail "无法识别包管理器，请手动安装 openssh-server 后重跑"
      fi
      ;;
  esac
}

# 若已装则跳过安装细节错误
if command -v sshd >/dev/null 2>&1 || dpkg -l openssh-server 2>/dev/null | grep -q '^ii'; then
  info "检测到 openssh 相关组件，继续确保服务开启"
fi

info "安装 openssh-server ..."
install_pkg

# 确保 host key 存在（极简安装偶发缺）
if [[ ! -f /etc/ssh/ssh_host_ed25519_key ]] && [[ ! -f /etc/ssh/ssh_host_rsa_key ]]; then
  warn "未发现 host key，尝试重新生成..."
  $SUDO ssh-keygen -A
fi

info "启用并启动服务: ${SERVICE_NAME}"
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl enable "${SERVICE_NAME}"
  $SUDO systemctl restart "${SERVICE_NAME}"
  sleep 1
  if $SUDO systemctl is-active --quiet "${SERVICE_NAME}"; then
    info "服务状态: active (running)"
  else
    warn "systemctl 显示未 active，尝试另一服务名..."
    for alt in ssh sshd; do
      if $SUDO systemctl restart "$alt" 2>/dev/null; then
        SERVICE_NAME="$alt"
        $SUDO systemctl enable "$alt" 2>/dev/null || true
        break
      fi
    done
  fi
else
  # 无 systemd 的老系统
  if command -v service >/dev/null 2>&1; then
    $SUDO service ssh start 2>/dev/null || $SUDO service sshd start 2>/dev/null || true
  fi
  warn "无 systemctl，已尝试 service 启动，请自行确认"
fi

# 防火墙放行（有则配，没有就跳过）
if command -v ufw >/dev/null 2>&1; then
  info "配置 ufw 放行 OpenSSH"
  $SUDO ufw allow OpenSSH >/dev/null 2>&1 || $SUDO ufw allow 22/tcp >/dev/null 2>&1 || true
  # 不强制 enable，避免断掉用户现有策略；若已启用则规则已生效
  if $SUDO ufw status 2>/dev/null | grep -qi 'Status: active'; then
    info "ufw 已 active，已放行 22"
  else
    warn "ufw 未启用（保持不动）。若稍后开启 ufw，记得: sudo ufw allow OpenSSH"
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  info "配置 firewalld 放行 ssh"
  $SUDO firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1 || true
  $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
fi

# 校验监听
echo
info "检查 22 端口监听..."
LISTEN_OK=0
if command -v ss >/dev/null 2>&1; then
  if $SUDO ss -tlnp 2>/dev/null | grep -E ':22\s' >/dev/null; then
    LISTEN_OK=1
    $SUDO ss -tlnp | grep -E ':22\s' || true
  fi
elif command -v netstat >/dev/null 2>&1; then
  if $SUDO netstat -tlnp 2>/dev/null | grep -E ':22\s' >/dev/null; then
    LISTEN_OK=1
    $SUDO netstat -tlnp | grep -E ':22\s' || true
  fi
fi

if [[ $LISTEN_OK -eq 1 ]]; then
  info "22 端口正在监听"
else
  fail "22 端口未监听。请执行: sudo journalctl -u ssh -n 50 --no-pager  （或 -u sshd）"
fi

# 打印本机信息，方便从 Mac 连接
USER_NAME="$(id -un)"
echo
echo "========================================"
echo -e "${GREEN}  完成！可以从 Mac 连接了${NC}"
echo "========================================"
echo "用户名: ${USER_NAME}"
echo "本机 IP:"
if command -v ip >/dev/null 2>&1; then
  ip -4 addr show scope global | awk '/inet /{print "  - " $2}' | cut -d/ -f1
else
  hostname -I 2>/dev/null | tr ' ' '\n' | sed 's/^/  - /' || true
fi
echo
echo "在 Mac 上执行（把 IP 换成上面 192.168.x.x）:"
echo "  ssh ${USER_NAME}@192.168.1.41"
echo
echo "若连不上，在本机再查一次:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo ss -tlnp | grep :22"
echo "========================================"
