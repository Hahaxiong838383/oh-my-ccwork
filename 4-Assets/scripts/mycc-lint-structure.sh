#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

RED="$(printf '\033[31m')"
YELLOW="$(printf '\033[33m')"
GREEN="$(printf '\033[32m')"
RESET="$(printf '\033[0m')"

warn_count=0
fail_count=0

green() {
  printf "%b[绿]%b %s\n" "$GREEN" "$RESET" "$1"
}

yellow() {
  warn_count=$((warn_count + 1))
  printf "%b[黄]%b %s\n" "$YELLOW" "$RESET" "$1"
}

red() {
  fail_count=$((fail_count + 1))
  printf "%b[红]%b %s\n" "$RED" "$RESET" "$1"
}

is_root_whitelisted() {
  case "$1" in
    .DS_Store|.adal|.agents|.augment|.claude|.codebuddy|.codex|.commandcode|.continue|.cortex|.crush|.env.example|.env.local|.factory|.gemini|.git|.github|.gitignore|.gitmodules|.goose|.iflow|.junie|.kilocode|.kiro|.kode|.local|.mcp.json|.mcpjam|.mux|.neovate|.obsidian|.openhands|.pi|.pochi|.qoder|.qwen|.roo|.secrets|.trae|.vibe|.windsurf|.zencoder)
      return 0
      ;;
    0-System|0-System.old|1-Inbox|2-Projects|3-Thinking|4-Assets|5-Archive|tasks)
      return 0
      ;;
    AGENTS.md|CHANGELOG.md|CLAUDE.md|GEMINI.md|MYCC_STARTUP_GUIDE.md|README.en.md|README.md)
      return 0
      ;;
    docs|img|multi-agent|mycc-web|node_modules|relay-server|rules|scripts|skills|web-terminal)
      return 0
      ;;
    install-daemon.sh|uninstall-daemon.sh|start-feishu-mycc.ps1|start-mycc.bat|start-mycc.ps1|start-mycc.sh|stop-mycc.bat|stop-mycc.ps1|stop-mycc.sh)
      return 0
      ;;
    package.json|package-lock.json|skills-lock.json)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

printf "mycc 结构检查：%s\n\n" "$ROOT"

if [ -L "0-System" ]; then
  target="$(readlink "0-System")"
  if [ -e "0-System" ] && [ -r "0-System" ]; then
    green "0-System symlink 可读 -> $target"
  else
    red "0-System symlink 不可读或目标不存在 -> $target"
  fi
elif [ -d "0-System" ] && [ -r "0-System" ]; then
  yellow "0-System 是可读目录，但不是 symlink；如需外置共享状态，请先确认后再调整"
else
  red "0-System 不存在或不可读"
fi

scatter_file="$(mktemp)"
find . -maxdepth 1 -mindepth 1 -print0 | while IFS= read -r -d '' path; do
  name="${path#./}"
  if ! is_root_whitelisted "$name"; then
    printf "%s\n" "$name"
  fi
done | sort > "$scatter_file"

scatter_count="$(wc -l < "$scatter_file" | tr -d ' ')"
if [ "$scatter_count" -eq 0 ]; then
  green "根目录未发现非白名单散落项"
else
  yellow "根目录发现 $scatter_count 个非白名单散落候选，只提醒不移动"
  sed 's/^/  - /' "$scatter_file"
fi
rm -f "$scatter_file"

inbox_count="$(find 1-Inbox -mindepth 1 -maxdepth 1 ! -name README.md ! -name .DS_Store -print 2>/dev/null | wc -l | tr -d ' ')"
if [ "$inbox_count" -le 20 ]; then
  green "1-Inbox 文件数 $inbox_count/20"
else
  yellow "1-Inbox 文件数 $inbox_count/20，建议清理"
fi

old_inbox_file="$(mktemp)"
find 1-Inbox -mindepth 1 -maxdepth 1 ! -name README.md ! -name .DS_Store -mtime +7 -print 2>/dev/null | sort > "$old_inbox_file"
old_inbox_count="$(wc -l < "$old_inbox_file" | tr -d ' ')"
if [ "$old_inbox_count" -eq 0 ]; then
  green "1-Inbox 未发现超过 7 天的待处理项"
else
  yellow "1-Inbox 有 $old_inbox_count 个超过 7 天的待处理项"
  sed 's/^/  - /' "$old_inbox_file"
fi
rm -f "$old_inbox_file"

missing_readme_file="$(mktemp)"
find 2-Projects -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | while IFS= read -r dir; do
  if [ ! -f "$dir/README.md" ]; then
    printf "%s\n" "$dir"
  fi
done | sort > "$missing_readme_file"

missing_readme_count="$(wc -l < "$missing_readme_file" | tr -d ' ')"
if [ "$missing_readme_count" -eq 0 ]; then
  green "2-Projects 子项目均有 README.md"
else
  yellow "2-Projects 有 $missing_readme_count 个项目缺 README.md"
  sed 's/^/  - /' "$missing_readme_file"
fi
rm -f "$missing_readme_file"

tasks_count="$(find tasks -mindepth 1 -maxdepth 1 ! -name README.md ! -name .gitkeep ! -name .DS_Store -print 2>/dev/null | wc -l | tr -d ' ')"
if [ "$tasks_count" -le 5 ]; then
  green "tasks 活跃项 $tasks_count/5"
else
  yellow "tasks 活跃项 $tasks_count/5，建议收敛或归档"
fi

# 身份事实防漂移：称呼/昵称类不应写入 memory-items（应在各引擎入口维护）
identity_in_mem="$(grep -nE '^- *(称呼|昵称)[:：]' 0-System/memory-items.md 2>/dev/null || true)"
if [ -z "$identity_in_mem" ]; then
  green "memory-items 无身份类条目（称呼/昵称归引擎入口，符合所有权规则）"
else
  yellow "memory-items 含身份类条目，应移到引擎入口（identity.md/AGENTS.md/GEMINI.md）后删除："
  printf "%s\n" "$identity_in_mem" | sed 's/^/  - /'
fi

printf "\n检查完成：红=%s，黄=%s\n" "$fail_count" "$warn_count"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
