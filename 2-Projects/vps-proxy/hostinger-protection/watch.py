#!/usr/bin/python3
"""home-studio 独立检查备份新鲜度，离线或资源告警显示在本机。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

state = Path.home() / ".local/state/hostinger-protection"
state.mkdir(mode=0o700, parents=True, exist_ok=True)
now = int(time.time())
issues = []
if not os.path.ismount("/data") or shutil.disk_usage("/data").free < 8 * 1024**3:
    issues.append("home-studio 备份盘未挂载或可用空间低于 8 GiB")
elif shutil.disk_usage("/data").free < 16 * 1024**3:
    issues.append("home-studio 备份盘可用空间低于 16 GiB")
if not Path("/data/home-studio/backups/hostinger/repo/config").is_file():
    issues.append("加密仓库配置缺失")
stamp = state / "last-success"
if not stamp.exists() or now - int(stamp.read_text()) > 43200:
    issues.append("Hostinger 备份超过 12 小时未成功")
if subprocess.run(["systemctl","--user","is-active","--quiet","hostinger-backup.timer"]).returncode:
    issues.append("home-studio 备份定时器已停止")
if subprocess.run(["systemctl","--user","is-failed","--quiet","hostinger-backup.service"]).returncode == 0:
    issues.append("上一次备份或维护任务失败")
try:
    remote = subprocess.run(["ssh","-T","-o","BatchMode=yes","-o","ConnectTimeout=12",
                             "-o","StrictHostKeyChecking=yes","-F",
                             str(Path.home()/".config/hostinger-protection/ssh.conf"),"hostinger-backup",
                             "cat /var/lib/hostinger-guard/state.json"],
                            capture_output=True, text=True, timeout=35)
    if remote.returncode:
        issues.append("VPS 巡检状态不可读，请检查 Tailscale、SSH 和巡检服务")
    else:
        data = json.loads(remote.stdout)
        if abs(now - data["checked"]) > 300:
            issues.append("VPS 巡检数据超过 5 分钟未刷新")
        if data["level"]:
            issues.append(f"VPS 磁盘告警等级 {data['level']}，详情见登录提示")
        if data["memory_alert"]:
            issues.append("VPS 可用内存已连续两分钟低于 1 GiB")
except (subprocess.TimeoutExpired, ValueError, KeyError):
    issues.append("VPS 巡检响应超时或数据无效")
notice = state / "notice"
old = notice.read_text() if notice.exists() else ""
msg = "\n".join(issues)
if old != msg or (msg and now - notice.stat().st_mtime > 43200):
    text = msg or "Hostinger 监控已恢复正常"
    print(text, flush=True)
    notice.write_text(msg)
    shown = subprocess.run(["timeout","8","notify-send","Hostinger 运维",text], capture_output=True)
    if shown.returncode:
        print("图形通知不可用，改用本机终端广播和持久状态文件", flush=True)
        subprocess.run(["wall"], input="Hostinger 运维\n"+text+"\n", text=True, timeout=10)
if issues:
    raise SystemExit(1)
