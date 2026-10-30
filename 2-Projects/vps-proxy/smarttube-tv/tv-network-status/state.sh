#!/system/bin/sh
# Pure input parsing; success is never inferred from progress logs.
status_phase() {
  _boot=$1; _ready=$2; _log=$3
  if [ "$(cat "$_ready" 2>/dev/null)" = "$_boot" ]; then
    printf 'ready\n'; return
  fi
  awk -v b="$_boot" '
    BEGIN { phase="connecting" }
    $2 == "boot=" b {
      if ($4 == "android_boot_complete") phase="clock"
      if ($4 == "clock_verified") phase="proxy"
      if ($4 == "main_launched" || $4 == "guardian_workers_finished") phase="dns"
      if ($4 == "dns_queries_verified" || $4 == "dns_cache_retry" || $4 == "dns_caches_flushed") phase="cache"
      if ($4 == "retry_later") phase="retry"
    }
    END { print phase }
  ' "$_log" 2>/dev/null
}
status_home() {
  awk '
    /topResumedActivity[:=]|mResumedActivity:/ {
      count++
      if ($0 ~ / u0 com\.dangbei\.tvlauncher\//) home=1; else home=0
    }
    END { if (count==1 && home) print "true"; else print "false" }
  '
}
status_event_home() {
  case "$1" in
    *'wm_set_resumed_activity'*'[0,com.dangbei.tvlauncher/'*) printf 'true\n' ;;
    *) printf 'false\n' ;;
  esac
}
