#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
kind="${1:-}"
title="${2:-}"

if [ -z "$kind" ]; then
  printf "用途/类型："
  IFS= read -r kind
fi

if [ -z "$title" ]; then
  printf "标题："
  IFS= read -r title
fi

if [ -z "$title" ]; then
  title="未命名"
fi

today="$(date +%F)"
safe_title="$(printf "%s" "$title" | tr ' /:' '---' | tr -cd '[:alnum:]_.-')"
if [ -z "$safe_title" ]; then
  safe_title="topic"
fi

printf "mycc 文件路由建议\n"
printf "类型：%s\n" "$kind"
printf "标题：%s\n\n" "$title"

case "$kind" in
  临时想法|想法|灵感|研究过程|Inbox|inbox)
    path="1-Inbox/${today}-${title}.md"
    note="未提炼或未判定归属的内容先进入 Intake Hall。"
    ;;
  项目资料|项目|项目文档|project|Project)
    path="2-Projects/<project-slug>/README.md 或 2-Projects/<project-slug>/${safe_title}.md"
    note="项目目录按英文短横线命名；若缺 README，先用项目状态卡模板补入口。"
    ;;
  方法论|认知沉淀|思考|thinking|Thinking)
    path="3-Thinking/NN-${title}.md"
    note="进入 Doctrine Wing 前需要有明确结论或可操作框架。"
    ;;
  SOP|模板|脚本|资产|asset|Asset|template|Template|script|Script)
    path="4-Assets/<SOP|Templates|scripts>/${safe_title}"
    note="只有可复用内容才进入 Tool Wing；按类型放入子目录。"
    ;;
  跨session任务|跨会话任务|任务|task|Task)
    path="tasks/${title}.md"
    note="Active Queue 只放跨 session 待办；完成后删除或归档。"
    ;;
  原子事实|记忆事实|memory-item|MemoryItem|长原文上下文|原文抽屉|长上下文|drawer|Drawer)
    path="（记忆类写入不走本脚本，请遵循 docs/memory-system.md）"
    note="记忆系统是独立且更精密的架构（Resource→Item→Category + 版本链 + 向量检索 + 主动遗忘），按 memory-system.md 操作；长原文需暂存时先放 1-Inbox。"
    ;;
  归档|archive|Archive)
    path="5-Archive/${safe_title}"
    note="归档前标注来源和日期；不要把活跃内容放进 Cold Storage。"
    ;;
  *)
    path="1-Inbox/${today}-${title}.md"
    note="未命中明确规则，保守放入 Intake Hall，后续整理。"
    ;;
esac

printf "建议路径：%s\n" "$path"
printf "说明：%s\n" "$note"
printf "\n本脚本只输出建议，不创建、不移动、不删除文件。\n"
