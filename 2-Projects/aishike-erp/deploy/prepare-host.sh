#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo "请使用日常账号运行，本脚本会在需要时调用 sudo。" >&2
  exit 1
fi

echo "安装前检查现有远程访问服务。"
sudo systemctl is-active --quiet frpc
sudo systemctl is-active --quiet sshd-public-tunnel
sudo systemctl is-active --quiet ssh

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker.io \
  docker-compose-v2 \
  git \
  curl

sudo systemctl enable --now docker
sudo usermod -aG docker "$(id -un)"

echo "安装后复核远程访问服务。"
sudo systemctl is-active --quiet frpc
sudo systemctl is-active --quiet sshd-public-tunnel
sudo systemctl is-active --quiet ssh
sudo docker version
sudo docker compose version

echo "主机准备完成。请退出当前 SSH 会话并重新连接，使 docker 用户组生效。"
