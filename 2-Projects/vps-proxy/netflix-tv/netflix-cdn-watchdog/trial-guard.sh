#!/system/bin/sh
sleep 300
if [ -f /data/adb/video-proxy/hybrid-pending ]; then
 sh /data/adb/video-proxy/rollback-hybrid.sh >> /data/adb/video-proxy/trial-guard.log 2>&1
fi
