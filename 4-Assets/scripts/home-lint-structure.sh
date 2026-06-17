#!/usr/bin/env bash
# HOME 层结构 lint —— 检测 ~ 顶层是否有白名单外的散落项（疑似 agent 乱建）
# 白名单单源 = ~/AGENTS.md 的 allowed_home_roots YAML 块；本脚本只解析、不内嵌（防漂移）
# 关键：lint_ignore_globs 仅作用于「文件」；点目录(.xxx/) 必须在白名单，否则报警（防 agent 用点目录绕过）
# 用法: bash home-lint-structure.sh
set -u

CONST="$HOME/AGENTS.md"
[ -f "$CONST" ] || { echo "✗ HOME 宪法不存在: $CONST"; exit 1; }

python3 - "$CONST" "$HOME" <<'PY'
import sys, os, re, fnmatch
const, home = sys.argv[1], sys.argv[2]
try:
    text = open(const, encoding="utf-8").read()
except OSError as e:
    print(f"✗ 读宪法失败: {e}"); sys.exit(1)

# 定位含 allowed_home_roots 的 yaml 块（不取第一个无关 yaml 块）
block = None
for m in re.finditer(r'```yaml(.*?)```', text, re.S):
    if 'allowed_home_roots' in m.group(1) or 'agent_cfg' in m.group(1):
        block = m.group(1); break
if block is None:
    print("✗ 宪法中未找到 allowed_home_roots yaml 白名单块"); sys.exit(1)

# 跨行解析 key: [ ... ]（支持折行，先去注释）
allowed, ignores = set(), []
for key, raw in re.findall(r'(\w+):\s*\[(.*?)\]', block, re.S):
    raw = re.sub(r'#.*', '', raw)
    vals = [x.strip().strip('\'"') for x in raw.split(',') if x.strip()]
    if not vals:
        continue
    if key == 'lint_ignore_globs':
        ignores = vals
    else:
        allowed.update(vals)

if not allowed:
    print("✗ 解析到的白名单为空，疑似 yaml 格式变化，请检查宪法"); sys.exit(1)

stray = []
try:
    names = sorted(os.listdir(home))
except OSError as e:
    print(f"✗ 无法列 HOME: {e}"); sys.exit(1)

for name in names:
    if name in allowed:
        continue
    try:
        is_dir = os.path.isdir(os.path.join(home, name))
    except OSError:
        is_dir = False
    # ignore globs 只豁免「文件」；目录(含点目录)不在白名单即报警
    if not is_dir and any(fnmatch.fnmatch(name, g) for g in ignores):
        continue
    stray.append((name, is_dir))

GREEN, YELLOW, RESET = "\033[32m", "\033[33m", "\033[0m"
print(f"HOME 结构检查: {home}")
print(f"白名单 {len(allowed)} 项 | 文件 ignore globs: {ignores}\n")
if not stray:
    print(f"{GREEN}[绿]{RESET} HOME 顶层无白名单外散落项")
else:
    print(f"{YELLOW}[黄]{RESET} HOME 顶层发现 {len(stray)} 个白名单外项（疑似 agent 乱建，只提醒不移动）:")
    for name, is_dir in stray:
        print(f"  - [{'目录' if is_dir else '文件'}] {name}")
    print(f"\n处理: 确认用途 → 移入 ~/mycc/ 对应子目录 / 删除 / 若为合法新顶层则先加入 ~/AGENTS.md 白名单")
PY
