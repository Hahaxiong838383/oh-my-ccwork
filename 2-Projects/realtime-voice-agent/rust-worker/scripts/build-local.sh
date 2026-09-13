#!/usr/bin/env bash
# 本地复刻 .github/workflows/rust-worker-build.yml（并在符号门禁上比 CI 更严）
#
# 为什么本地能建：CI 走 GH runner 是因为 dev198 是 26.04/glibc 2.43，产物带
# GLIBC_2.43 符号跑不了目标机 64.90（24.04/glibc 2.39）。而 home-studio 本身就是
# Ubuntu 24.04/glibc 2.39 —— 它就是目标环境，不需要绕道 CI。
#
# 用法:  bash scripts/build-local.sh          正常构建
#        bash scripts/build-local.sh --check   只做环境与门禁自检，不编译
set -euo pipefail

# ssh host 'cmd' 是非交互 shell，读不到 .bashrc 里 return 之后的 PATH
export PATH="$HOME/.cargo/bin:$PATH"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ⚠️ 两个上限都锚【目标机 64.90】的能力，不是本机的。
#    拿本机能力当上限，本机产物永远不可能超标 → 门禁恒绿 → 等于没装。
CEILING=39            # glibc 次版本上限（2.39），与 CI 判据一致
CXX_CEILING="3.4.33"  # libstdc++ 上限。CI 没查这层，这是本脚本比 CI 严的地方。
                      # 3.4.33 = Ubuntu 24.04(gcc 13) 的供给量，按「64.90 同为 24.04」推断得出，
                      # 【未实测目标机】。等有了 SSH 凭据，用这条取真值再回来改：
                      #   ssh root@64.90.13.117 "strings /lib/x86_64-linux-gnu/libstdc++.so.6 \
                      #     | grep -oE '^GLIBCXX_[0-9.]+' | sort -u -V | tail -1"
BIN=target/release/voice-rust-worker

ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '   \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# 判据一：GLIBC_2.x，任何 x > CEILING 即失败。与 CI 同款。
# 抽成函数是为了能对判据本身做负向验证（见「门禁自检」）。
glibc_gate() {
  awk -F. -v ceil="$CEILING" '
    $2 > ceil { print "   TOO NEW: " $0; bad = 1 }
    END { exit bad }
  '
}

# 判据二：GLIBCXX_3.4.x（libstdc++ 版本化符号）。
# ⚠️ 必须用 sort -V 而不是普通 sort：字符串序里 "3.4.9" > "3.4.31"，会漏判。
# 无 GLIBCXX 符号（纯 C 产物）视为通过。
glibcxx_gate() {
  local max
  max=$(sort -u -V | tail -1)
  [ -z "$max" ] && return 0
  if [ "$(printf '%s\n%s\n' "$max" "GLIBCXX_$CXX_CEILING" | sort -V | tail -1)" != "GLIBCXX_$CXX_CEILING" ]; then
    printf '   TOO NEW: %s（上限 GLIBCXX_%s）\n' "$max" "$CXX_CEILING"
    return 1
  fi
  return 0
}

step "1/4 系统依赖"
MISSING=()
for p in libglib2.0-dev pkg-config; do
  if LC_ALL=C dpkg -l "$p" 2>/dev/null | awk '$1=="ii"{f=1} END{exit !f}'; then
    ok "$p"
  else
    bad "$p 未装"; MISSING+=("$p")
  fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo
  echo "   需要先装（webrtc-sys 构建要 glib 头）："
  echo "   sudo apt install -y ${MISSING[*]}"
  exit 1
fi

step "2/4 工具链"
command -v cargo >/dev/null || { bad "找不到 cargo"; exit 1; }
ok "$(rustc -V)"
ok "$(cargo -V)"
ok "本机 glibc: $(LC_ALL=C ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$')   门禁上限 2.$CEILING"
ok "本机 libstdc++ 供给: $(strings /lib/x86_64-linux-gnu/libstdc++.so.6 2>/dev/null | grep -oE '^GLIBCXX_[0-9.]+' | sort -u -V | tail -1)   门禁上限 GLIBCXX_$CXX_CEILING"

# 负向验证：拿必然超标的输入喂给判据，确认它真的会变红。
# 不做这步的话，判据写错会恒绿——那比没有门禁更危险（会给出「已检查」的假象）。
step "门禁自检（负向验证）"
if printf 'GLIBC_2.43\n' | glibc_gate >/dev/null 2>&1; then
  bad "判据对 GLIBC_2.43 没报错 —— glibc 门禁失效，中止"; exit 1
fi
ok "glibc  喂 2.43 → 正确变红"
if ! printf 'GLIBC_2.39\nGLIBC_2.17\n' | glibc_gate >/dev/null 2>&1; then
  bad "判据对合法的 2.39/2.17 误报 —— 判据过严，中止"; exit 1
fi
ok "glibc  喂 2.39/2.17 → 正确放行"

if printf 'GLIBCXX_3.4.99\n' | glibcxx_gate >/dev/null 2>&1; then
  bad "判据对 GLIBCXX_3.4.99 没报错 —— libstdc++ 门禁失效，中止"; exit 1
fi
ok "libstdc++ 喂 3.4.99 → 正确变红"
if ! printf 'GLIBCXX_3.4.9\nGLIBCXX_3.4.31\n' | glibcxx_gate >/dev/null 2>&1; then
  bad "判据对合法的 3.4.31 误报 —— 判据过严，中止"; exit 1
fi
ok "libstdc++ 喂 3.4.9/3.4.31 → 正确放行（顺带验了 3.4.9 不被误当成最大）"
if ! printf "GLIBCXX_$CXX_CEILING\n" | glibcxx_gate >/dev/null 2>&1; then
  bad "判据把等于上限的 $CXX_CEILING 判成超标 —— 边界错误，中止"; exit 1
fi
ok "libstdc++ 喂 $CXX_CEILING（正好等于上限）→ 正确放行"

if [ "${1:-}" = "--check" ]; then
  echo
  ok "自检完成（未编译）"
  exit 0
fi

step "3/4 编译 release"
cargo build --release --locked

step "4/4 符号天花板（glibc + libstdc++）"
[ -f "$BIN" ] || { bad "产物不存在: $BIN"; exit 1; }

SYMS=$(objdump -T "$BIN" | grep -o 'GLIBC_2\.[0-9]*' | sort -t. -k2 -n -u)
echo "   glibc 需求: $(printf '%s' "$SYMS" | tr '\n' ' ')"
if ! printf '%s\n' "$SYMS" | glibc_gate; then
  bad "存在高于 2.$CEILING 的 glibc 符号，产物在 64.90 上跑不起来"; exit 1
fi
ok "glibc 全部 ≤ 2.$CEILING"

CXXSYMS=$(objdump -T "$BIN" | grep -oE 'GLIBCXX_[0-9.]+' | sort -u -V || true)
if [ -z "$CXXSYMS" ]; then
  ok "产物不依赖 libstdc++ 版本化符号"
else
  echo "   libstdc++ 需求最高: $(printf '%s' "$CXXSYMS" | tail -1)"
  if ! printf '%s\n' "$CXXSYMS" | glibcxx_gate; then
    bad "存在高于 GLIBCXX_$CXX_CEILING 的符号，产物在 64.90 上跑不起来"; exit 1
  fi
  ok "libstdc++ 全部 ≤ GLIBCXX_$CXX_CEILING"
fi

step "产物"
ls -lh "$BIN" | sed 's/^/   /'
echo "   md5: $(md5sum "$BIN" | cut -d' ' -f1)"
echo
echo "   下一步（部署到 64.90，需要 SSH 凭据）："
echo "     scp $BIN root@64.90.13.117:/root/voice-rust-worker.new"
echo "     然后在目标机跑 deploy-worker-bin.sh（自动备份 + 纪律重启 + md5 锚点核对）"
