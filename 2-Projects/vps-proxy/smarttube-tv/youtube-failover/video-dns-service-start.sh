#!/system/bin/sh
# Called asynchronously by service.d, after the blocking early DNS protection.
umask 077
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
installed=$(cat "$D/dns-guard-installed-boot-id" 2>/dev/null)
if [ -z "$boot" ] || [ -z "$installed" ] || [ "$boot" = "$installed" ]; then
  echo 'video-dns-service: deferred until next boot'
  exit 0
fi
P="$D/dns-upgrade-20261024"
# A partial interrupted transaction must be completed before starting either
# main or guardian; unknown drift refuses startup and retains DNS protection.
if ! sh "$P/dns-upgrade-apply.sh" --apply >> "$D/dns-upgrade.log" 2>&1; then
  # A failed transaction may have restored the entire old release. Re-enter
  # its verifier once to prove that state before continuing the old boot path.
  [ "$(cat "$P/rolled-back-boot-id" 2>/dev/null)" = "$boot" ] || exit 1
  sh "$P/dns-upgrade-apply.sh" --apply >> "$D/dns-upgrade.log" 2>&1 || exit 1
fi
exec sh "$D/video-boot-start.sh"
