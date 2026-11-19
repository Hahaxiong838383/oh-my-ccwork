#!/bin/bash
set -euo pipefail

# Package an already signed App. No build, code mutation, re-signing, or installation.
usage() {
  cat <<'HELP'
用法：package-dmg.sh --app /路径/App.app --output /路径/安装包.dmg

只打包已签名 App；保留现有签名，生成只读 UDZO 镜像。
镜像含 App、指向 /Applications 的快捷方式和中文安装/权限说明。
输出目录须已存在；建议输出到项目 artifacts/，已有输出不会被覆盖。
HELP
}

fail() { printf '错误：%s\n' "$1" >&2; exit 1; }

app_input=''
output_input=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 && -n "$2" ]] || fail '--app 需要路径。'
      [[ -z "$app_input" ]] || fail '--app 不得重复。'
      app_input="$2"; shift 2 ;;
    --output)
      [[ $# -ge 2 && -n "$2" ]] || fail '--output 需要路径。'
      [[ -z "$output_input" ]] || fail '--output 不得重复。'
      output_input="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail '未知参数；使用 --help 查看用法。' ;;
  esac
done
[[ -n "$app_input" && -n "$output_input" ]] || fail '必须指定 --app 和 --output。'
[[ "$app_input" = *.app && -d "$app_input" ]] || fail '--app 必须是现有 .app 目录。'
[[ "$output_input" = *.dmg ]] || fail '--output 必须以 .dmg 结尾。'
[[ -f "$app_input/Contents/Info.plist" ]] || fail 'App 缺少 Contents/Info.plist。'

case "$app_input" in
  /*) app_absolute="$app_input" ;;
  *) app_absolute="$PWD/$app_input" ;;
esac
app_path="$(cd "$app_absolute" && pwd -P)"
app_name="$(basename "$app_path")"
case "$output_input" in
  /*) output_path="$output_input" ;;
  *) output_path="$PWD/$output_input" ;;
esac
output_directory="$(dirname "$output_path")"
[[ -d "$output_directory" ]] || fail '输出目录不存在；请先建立 artifacts/ 等目标目录。'
output_directory="$(cd "$output_directory" && pwd -P)"
output_path="$output_directory/$(basename "$output_path")"
[[ "$output_path" != "$app_path/"* ]] || fail '输出不得位于输入 App 内。'
[[ ! -e "$output_path" && ! -L "$output_path" ]] || fail '输出已存在；请使用新的文件名。'

# Verification accepts ad-hoc signatures but does not assert Developer ID trust/notarization.
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
stage="$(mktemp -d "$output_directory/.nio-warp-dmg.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/payload"
/usr/bin/ditto --rsrc --extattr --acl "$app_path" "$stage/payload/$app_name"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$stage/payload/$app_name"
ln -s /Applications "$stage/payload/Applications"
cat > "$stage/payload/安装与权限说明.txt" <<TEXT
安装 $app_name

1. 先退出已运行的应用，记录原来唯一的安装路径和启动入口。
2. 已有安装：退出后用此 App 替换原路径中的 App，包括 ~/Applications。
   不要因为镜像有 Applications 快捷方式就另装第二份，也不要混用旧启动入口。
3. 新电脑首次安装：将 App 拖到此镜像内 Applications 快捷方式（/Applications）。
4. 弹出此镜像，从已经安装的固定路径启动；不要从镜像或 Downloads 中直接运行。

此镜像只包含软件、目录快捷方式和说明，不包含您电脑当刻的现场标定与预设备份。
它不会迁移、恢复或替您授权参数。更换电脑前请由您私有备份所需设置并核对兼容性；
普通软件回退不要用旧整份偏好覆盖最新校正参数。

权限必须在每台电脑分别授权，不能由另一台电脑的权限或备份包替代：
NIO Warp 捕获画面需要“屏幕与系统音频录制”；原生鼠标/键盘控制按需授予“辅助功能”；
浏览器控制若出现自动化请求，按实际操作授予 Chrome 控制。授权后退出应用并重新打开。
安装路径或签名身份变化仍可能要求重新授权；先确认正在授权的是唯一安装副本。

本打包脚本不重新签名、不公证 App；实际签名、架构和版本以交付清单为准。
受控测试/ad-hoc 包若被 macOS 或组织策略阻止，联系交付方或公司 IT 按批准的
测试/签名流程处理，不关闭系统整体安全保护。Connect 账号与授权由用户自行管理。
TEXT

/usr/bin/hdiutil create -quiet -volname 'NIO Warp 安装' -srcfolder "$stage/payload" \
  -fs HFS+ -format UDZO "$stage/package.dmg"
/usr/bin/hdiutil verify -quiet "$stage/package.dmg"
# -n preserves an output created by another packaging process after our initial check.
mv -n "$stage/package.dmg" "$output_path"
[[ ! -e "$stage/package.dmg" ]] || fail '输出已被其它任务创建，未覆盖。'
printf '%s\n' "$output_path"
