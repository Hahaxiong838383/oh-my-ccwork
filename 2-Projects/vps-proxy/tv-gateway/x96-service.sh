#!/system/bin/sh
# Install as service.d/99-gateway.sh, replacing the old sysctl writer.
PATH=/system/bin:/system/xbin
export PATH
/system/bin/sh /data/adb/dsh-gateway/x96-network.sh --watch </dev/null >/dev/null 2>&1 &
/system/bin/sh /data/adb/dsh-gateway/x96-gateway-watch.sh </dev/null >/dev/null 2>&1 &
