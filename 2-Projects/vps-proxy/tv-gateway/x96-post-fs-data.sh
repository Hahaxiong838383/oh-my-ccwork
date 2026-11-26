#!/system/bin/sh
# Early Magisk phase blocks Zygote. Try once, without waiting for eth0/netd.
PATH=/system/bin:/system/xbin
export PATH
/system/bin/sh /data/adb/dsh-gateway/x96-network.sh --early ||
  log -t X96Network 'Early rules incomplete; service stage will retry'
