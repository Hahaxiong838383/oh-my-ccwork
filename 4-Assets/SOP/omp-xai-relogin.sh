#!/usr/bin/env bash
# omp xai-oauth(SuperGrok / grok-4.3) 一键重登 + 固化 + 验证
#
# 何时跑：team 模式 B4 grok lane 报 "Refresh token has been revoked"
#         或 omp-xai-token-refresh.py 退出码 3(所有 refresh token 失效)。
# 在哪跑：⚠️ 必须在川哥的【真实终端】跑——会弹浏览器走 xAI OAuth 授权(只有你能点)。
#         cc 的非交互 shell 跑会 readline EOF 崩。
#
# 做四件事：
#   1. grok logout + login   → 浏览器授权，写新鲜 ~/.grok/auth.json
#   2. --import-from-grok     → 把新 token 固化进 omp agent.db(清 disabled_cause)
#   3. E2E 实测 grok-4.3       → 确认 team 真能调
#   4. 激活 launchd 保鲜定时器 → 之后每 2h 自动刷新，永不再 war
#
# 背景见 memory project_omp_grok43 + 同目录 omp-xai-token-refresh.py 头注释。
set -uo pipefail

GROK="$HOME/.grok/bin/grok"
REFRESH="$HOME/mycc/4-Assets/SOP/omp-xai-token-refresh.py"
PLIST="$HOME/Library/LaunchAgents/com.omp.xai-token-refresh.plist"
export PATH="$HOME/.bun/bin:$PATH"

# 境外 endpoint 走代理；localhost callback 不走代理
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:10808}"
export NO_PROXY="localhost,127.0.0.1,::1,.local"

echo "===== ① grok OAuth 重新登录 (浏览器授权) ====="
[ -x "$GROK" ] || { echo "❌ grok CLI 不在 $GROK"; exit 1; }
"$GROK" logout >/dev/null 2>&1 || true   # 清掉已吊销的缓存
echo "→ 即将弹出浏览器，请用川哥的 xAI/Grok 账号点【授权 / Authorize】..."
"$GROK" login || { echo "❌ grok login 失败(检查代理/网络/账号)"; exit 1; }

# 校验 auth.json 新鲜
python3 - <<'PY' || exit 1
import json, datetime, sys, os
p=os.path.expanduser("~/.grok/auth.json")
try:
    inner=next(iter(json.load(open(p)).values()))
    exp=datetime.datetime.fromisoformat(inner["expires_at"].replace("Z","+00:00"))
    left=(exp-datetime.datetime.now(datetime.timezone.utc)).total_seconds()/60
    if left<=0:
        print(f"❌ 登录后 auth.json 仍过期(剩 {left:.0f}min),登录可能没成功"); sys.exit(1)
    print(f"✅ ~/.grok/auth.json 已刷新，access token 剩余 {left:.0f} 分钟")
except Exception as e:
    print(f"❌ 读 auth.json 失败: {e}"); sys.exit(1)
PY

echo ""
echo "===== ② 固化进 omp agent.db ====="
python3 "$REFRESH" --import-from-grok || { echo "❌ 固化失败"; exit 1; }

echo ""
echo "===== ③ E2E 实测 omp xai-oauth/grok-4.3 (team 真链路) ====="
OUT=$(omp -p --model xai-oauth/grok-4.3 --thinking minimal --no-tools \
  --no-extensions --no-skills --no-rules \
  "用一句话报告:你是哪个模型?今天几号?" 2>/tmp/relogin-grok.err)
RC=$?
if [ $RC -eq 0 ] && [ -n "$OUT" ]; then
  echo "✅ grok-4.3 响应正常:"
  echo "   $OUT" | head -3
else
  echo "❌ grok-4.3 调用失败 (RC=$RC):"; tail -5 /tmp/relogin-grok.err
  exit 1
fi

echo ""
echo "===== ④ 激活 launchd 保鲜定时器 (每 2h 自动刷新) ====="
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST" && echo "✅ com.omp.xai-token-refresh 已加载"
launchctl kickstart -k "gui/$(id -u)/com.omp.xai-token-refresh" 2>/dev/null || true

echo ""
echo "🎉 全部完成。team 模式 grok lane 现已恢复，且自动刷新已接管。"
echo "   日常验证: python3 $REFRESH --check"
echo "   保鲜日志: ~/Library/Logs/omp-xai-token-refresh.log"
