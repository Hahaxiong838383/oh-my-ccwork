#!/bin/bash
# pull-air-replay.sh — 每日 12:30：在 Air 上跑回放世界转换器，把结构化轨迹拉回开发机，再重跑评估器。
# 2026-09-23 川哥放行（12:30 Air 大概率开机在线）。
# Air 侧只有一个脚本 ~/.claude/scripts/build-replay-world.py，不装定时任务；输出 ~/.local/share/replay-world/（不在任何 git 仓）：
#   ⚠️ 不能用默认的 ~/.mycc-global/0-System/trajectories（Air 每天 add -A 提交并推 GitHub），
#   也不能用 ~/.claude/ 下任何位置（Air 的 ~/.claude 是 git 仓，远端 myclaudecode，一次全量暂存就会带上去）。
# ⚠️ 拉取不带 --delete：Air 会话记录会轮转，轨迹要比原始记录活得久（本机 5 天内 transcript 37→19，轨迹仍 40）。
# Air 不可达（离线/不在公司网络）→ 记一行日志、正常退出，不算失败。
set -uo pipefail
AIR_SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -J dev198 rayman.chen@RaymanMacBook-Air.local)
DST="$HOME/.mycc-global/0-System/trajectories-air"
LOG="$HOME/.mycc-global/0-System/trajectories/build.log"
ts(){ date '+%Y-%m-%d %H:%M:%S'; }
mkdir -p "$DST"
if ! "${AIR_SSH[@]}" true >/dev/null 2>&1; then echo "$(ts) [air-pull] Air 不可达，跳过" >> "$LOG"; exit 0; fi
out=$("${AIR_SSH[@]}" 'P=""; for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do [ -x "$c" ] && P="$c" && break; done; [ -n "$P" ] || { echo NO_PYTHON; exit 3; }; "$P" ~/.claude/scripts/build-replay-world.py --out ~/.local/share/replay-world' 2>&1); rc=$?
if [ $rc -ne 0 ]; then echo "$(ts) [air-pull] Air 上转换失败 rc=$rc: $(echo "$out" | tail -2 | tr '\n' ' ')" >> "$LOG"; exit 1; fi
if rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=10 -J dev198" 'rayman.chen@RaymanMacBook-Air.local:.local/share/replay-world/' "$DST/"; then
  chmod 600 "$DST"/*.jsonl "$DST"/MANIFEST.json 2>/dev/null
  echo "$(ts) [air-pull] ok：$(echo "$out" | tr -d '\n ' | grep -oE '"traces_written":[0-9]+,"window":\[[^]]*\],"substantive":[0-9]+') 本地累计 $(ls "$DST"/*.jsonl 2>/dev/null | wc -l) 条" >> "$LOG"
else
  echo "$(ts) [air-pull] rsync 失败" >> "$LOG"; exit 1
fi
# 评估器的尺子（2026-09-23 P0）：Air ~/.claude 仓记忆路径的 git 历史 → ①出生台账（每个文件首次入库时间，替代会被编辑/同步刷新的 mtime）
# ②逐次差异（后来追加的链接按追加时刻算、往老教训追加「变体」小节算自身复发）。两条在 Air 上都是只读 git log，失败沿用上一版。
EV="$HOME/mycc/4-Assets/scripts/evaluate-memory-policy.py"; EVD="$HOME/.local/share/memory-eval"; mkdir -p "$EVD"
MP='projects/-Users-rayman-chen-mycc/memory/'
if "${AIR_SSH[@]}" "git -C ~/.claude log --reverse --diff-filter=A --format=@%at --name-only -- $MP" > "$EVD/air-births.log.tmp" 2>>"$LOG" && [ -s "$EVD/air-births.log.tmp" ]; then
  echo "$(ts) [air-pull] $(/usr/bin/python3 "$EV" --seed-births < "$EVD/air-births.log.tmp" 2>&1 | tail -1)" >> "$LOG"
else
  echo "$(ts) [air-pull] 出生台账回填失败，沿用旧台账" >> "$LOG"
fi
rm -f "$EVD/air-births.log.tmp"
if "${AIR_SSH[@]}" "git -C ~/.claude log --since=2026-08-20 -p --reverse --no-renames --format='@@COMMIT %at' -- $MP ':(exclude)${MP}MEMORY.md' ':(exclude)${MP}INDEX-full.md'" > "$EVD/air-memory-diff.log.tmp" 2>>"$LOG" && [ -s "$EVD/air-memory-diff.log.tmp" ]; then
  mv "$EVD/air-memory-diff.log.tmp" "$EVD/air-memory-diff.log"; chmod 600 "$EVD/air-memory-diff.log"
  echo "$(ts) [air-pull] 记忆差异日志已更新（$(grep -c '^@@COMMIT' "$EVD/air-memory-diff.log") 个提交）" >> "$LOG"
else
  rm -f "$EVD/air-memory-diff.log.tmp"; echo "$(ts) [air-pull] 记忆差异日志拉取失败，沿用上一版" >> "$LOG"
fi
/usr/bin/python3 "$EV" > "$HOME/mycc/1-Inbox/评估器日报-latest.md" 2>>"$LOG" && echo "$(ts) [air-pull] 评估器已重跑" >> "$LOG"
