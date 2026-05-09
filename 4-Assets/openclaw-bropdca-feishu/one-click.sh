#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
#  OpenClaw BRO-PDCA 一键安装
#  用法：bash one-click.sh
# ═══════════════════════════════════════════════════════
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEM_PROMPT="$SCRIPT_DIR/openclaw-system-prompt.txt"

echo "══════════════════════════════════════"
echo "  OpenClaw BRO-PDCA 一键安装 v1.0"
echo "══════════════════════════════════════"
echo ""

# ── 1. 找 openclaw 目录 ────────────────────────────────
find_openclaw() {
  for dir in "$HOME/.openclaw" "$HOME/.clawdbot" "$HOME/.moldbot"; do
    [[ -d "$dir" ]] && echo "$dir" && return
  done
  echo "$HOME/.openclaw"
}
OPENCLAW_DIR="$(find_openclaw)"
AGENT_DIR="$OPENCLAW_DIR/agents/main"
INSTRUCTIONS_DIR="$AGENT_DIR/instructions"

echo "📂 安装目录：$OPENCLAW_DIR"

# ── 2. 备份旧文件 ──────────────────────────────────────
if [[ -d "$INSTRUCTIONS_DIR" ]]; then
  BACKUP="$AGENT_DIR/instructions.backup.$(date +%Y%m%d_%H%M%S)"
  cp -r "$INSTRUCTIONS_DIR" "$BACKUP"
  echo "✅ 已备份原有指令 → $(basename "$BACKUP")"
fi

# ── 3. 安装新文件 ──────────────────────────────────────
mkdir -p "$INSTRUCTIONS_DIR"
for f in SYSTEM.md bropdca-feishu.md quick-reference.md openclaw-system-prompt.txt; do
  cp "$SCRIPT_DIR/$f" "$INSTRUCTIONS_DIR/$f"
done
echo "✅ 指令文件已安装"

# ── 4. 写入 openclaw.json ──────────────────────────────
CONFIG_FILE=""
for fname in openclaw.json clawdbot.json moldbot.json; do
  [[ -f "$OPENCLAW_DIR/$fname" ]] && CONFIG_FILE="$OPENCLAW_DIR/$fname" && break
done

if [[ -n "$CONFIG_FILE" ]]; then
  python3 - "$CONFIG_FILE" "$SYSTEM_PROMPT" <<'PYEOF'
import json, sys, os, pathlib

cfg_path   = pathlib.Path(sys.argv[1])
prompt_txt = pathlib.Path(sys.argv[2]).read_text()

cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
cfg.setdefault("agent", {})["system_prompt"] = prompt_txt

tmp = cfg_path.with_suffix(".tmp")
tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
os.replace(tmp, cfg_path)
print(f"✅ 已写入 system_prompt → {cfg_path}")
PYEOF
else
  # 没有 config 文件，创建一个新的
  mkdir -p "$OPENCLAW_DIR"
  python3 - "$OPENCLAW_DIR/openclaw.json" "$SYSTEM_PROMPT" <<'PYEOF'
import json, sys, os, pathlib

cfg_path   = pathlib.Path(sys.argv[1])
prompt_txt = pathlib.Path(sys.argv[2]).read_text()

cfg = {"agent": {"system_prompt": prompt_txt}}

tmp = cfg_path.with_suffix(".tmp")
tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
os.replace(tmp, cfg_path)
print(f"✅ 已创建配置文件 → {cfg_path}")
PYEOF
fi

# ── 5. 完成提示 ────────────────────────────────────────
echo ""
echo "══════════════════════════════════════"
echo "  🎉 安装完成！"
echo "══════════════════════════════════════"
echo ""
echo "下一步："
echo "  重启 openclaw 后生效。"
echo ""
echo "  如果 openclaw 不支持自动读取配置，"
echo "  请手动把以下文件内容复制粘贴到"
echo "  openclaw 的「系统提示词」设置框里："
echo ""
echo "  👉 $INSTRUCTIONS_DIR/openclaw-system-prompt.txt"
echo ""
