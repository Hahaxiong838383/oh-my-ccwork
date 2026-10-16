#!/bin/sh
: '通过专用代理启动原版 Grok Bot，不修改应用签名或登录数据。'
/usr/bin/env python3 "$(dirname "$0")/grok-bot-lisa-launch.py" "$@"
launch_status=$?
if [ "$launch_status" -ne 0 ]; then
    printf '\n启动失败，保留终端窗口供检查。\n'
    exit "$launch_status"
fi

for argument in "$@"; do
    case "$argument" in
        --prepare-only|--help|-h) exit 0 ;;
    esac
done

if [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ] && [ -t 0 ]; then
    terminal_tty=$(/usr/bin/tty)
    printf '\n启动成功，3 秒后自动关闭本启动窗口；多标签或仍有任务的窗口保留。\n'
    /usr/bin/nohup /usr/bin/osascript - "$terminal_tty" >/dev/null 2>&1 <<'APPLESCRIPT' &
on run arguments
    set targetTTY to item 1 of arguments
    set targetWindowID to missing value
    tell application "Terminal"
        repeat with terminalWindow in windows
            if (count of tabs of terminalWindow) is 1 then
                if tty of tab 1 of terminalWindow is targetTTY then
                    set targetWindowID to id of terminalWindow
                    exit repeat
                end if
            end if
        end repeat
    end tell
    if targetWindowID is missing value then return
    delay 3
    tell application "Terminal"
        repeat with terminalWindow in windows
            if id of terminalWindow is targetWindowID then
                if (count of tabs of terminalWindow) is 1 then
                    set terminalTab to tab 1 of terminalWindow
                    if tty of terminalTab is targetTTY and not (busy of terminalTab) then
                        close terminalWindow
                    end if
                end if
                exit repeat
            end if
        end repeat
    end tell
end run
APPLESCRIPT
fi
exit 0
