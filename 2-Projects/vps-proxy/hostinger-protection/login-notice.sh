if [ -r /var/lib/hostinger-guard/notice ] && [ -s /var/lib/hostinger-guard/notice ]; then
    printf '\nHostinger 资源告警\n'
    cat /var/lib/hostinger-guard/notice
fi
if [ ! -f /var/lib/hostinger-guard/state.json ] || [ -n "$(find /var/lib/hostinger-guard/state.json -mmin +5 -print 2>/dev/null)" ]; then
    printf '\nHostinger 巡检状态超过 5 分钟未刷新，请检查 hostinger-guard.timer。\n'
fi
