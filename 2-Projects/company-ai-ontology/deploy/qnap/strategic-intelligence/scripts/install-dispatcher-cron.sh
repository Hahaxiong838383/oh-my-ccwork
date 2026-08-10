#!/bin/sh
set -eu
exec </dev/null

[ "${SHADOW_DEPLOY_APPROVED:-NO}" = YES ] || { echo 'explicit shadow deployment approval missing' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
crontab_file=/etc/config/crontab
marker='# company-strategic-intelligence-shadow-dispatcher'
command="$script_root/dispatch-next.sh >> $shadow_root/state/dispatcher.log 2>&1"
temporary=$shadow_root/state/crontab.$$.tmp
awk -v marker="$marker" 'index($0, marker) == 0' "$crontab_file" > "$temporary"
printf '* * * * * %s %s\n' "$command" "$marker" >> "$temporary"
cat "$temporary" > "$crontab_file"
rm -f "$temporary"
crontab "$crontab_file"
printf 'strategic_intelligence_dispatcher_schedule=installed\ncron_daemon_restart=0\n'
