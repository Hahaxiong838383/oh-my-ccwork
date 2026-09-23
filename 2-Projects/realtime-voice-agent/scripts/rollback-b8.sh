#!/usr/bin/env bash
# B8 一键回滚(2026-07-31):同事报"开场白丢失/身份错乱/对话异常"时执行。
#
# 回滚的是入房提速那一版(330d75ce1):等 participant 后置 + identity 延迟注入 +
# 按 provider 预 import。快照 rollback-batch2-0731.tar.gz 更早,含 B9 之前的全部代码,
# 只在"连 B9 一起退干净"时才用它。
#
# 用法(mycc 仓根):bash 2-Projects/realtime-voice-agent/scripts/rollback-b8.sh
# ⚠️ 2026-09-23 阶段 3 注：本脚本针对老机 64.90.13.117 上的 python 线（voice-worker 单元已不存在，只剩 voice-worker-colleague）；
#    rust 生产池 2026-09-22 起在 64.90.13.177（hk2），其回滚用 hk2 上的 deploy-worker-bin.sh 备份文件，与本脚本无关。
set -euo pipefail

HOST=root@64.90.13.117
PROJ=/Users/rayman.chen/mycc/2-Projects/realtime-voice-agent

echo "== 1/4 本地回退 B8 提交(保留 B9 及之后的改动) =="
cd "$PROJ/../.."
git revert --no-edit 330d75ce1

echo "== 2/4 同步到生产 =="
rsync -az --exclude '__pycache__' "$PROJ/src/" "$HOST:/root/realtime-voice-agent/src/"

echo "== 3/4 重启两个 worker =="
ssh "$HOST" 'systemctl restart voice-worker voice-worker-colleague && sleep 4 && systemctl is-active voice-worker voice-worker-colleague'

echo "== 4/4 确认注册成功 =="
ssh "$HOST" 'journalctl -u voice-worker-colleague --since "1 minute ago" --no-pager | grep -c "registered worker"'

echo "✅ B8 已回滚。通知同事重测;join timing 日志会退回粗粒度口径。"
