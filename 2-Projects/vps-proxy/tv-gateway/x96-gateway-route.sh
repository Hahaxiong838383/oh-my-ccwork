#!/system/bin/sh
# X96 IPv4 data plane. Run as root: apply|check 192.168.1.19|192.168.1.254.
# netd first selects the app's interface and source. Only locally generated
# eth0 packets from the TV receive a spare routing bit in mangle OUTPUT.
# Linux then repeats the lookup with that bit; network IDs and VPN routes
# remain intact. Test ordinary sockets on the wire, not just the first lookup.
set -u
umask 077
action=${1:-}
wanted=${2:-}
case "$action" in apply|check) ;; *) exit 2;; esac
case "$wanted" in 192.168.1.19|192.168.1.254) ;; *) exit 2;; esac
primary=192.168.1.19
backup=192.168.1.254
tv=192.168.1.144
lan=192.168.1.0/24
table=189
pref=8999
own=0x20000000/0x20000000
probe=0x40000000/0x40000000
dir=/data/adb/dsh-gateway
receipt=/data/misc/x96-boot-status/gateway
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
[ -n "$boot" ] || exit 1
lock="$dir/x96-gateway-route.lock"
exec 9>"$lock" || exit 1
flock -n 9 9>&9 || exit 1

err() { echo "x96-gateway-route: $*" >&2; }
nf() { iptables -w 3 -t "$@"; }
hook_lines() {
    case "$1" in
    nat) echo '-A OUTPUT -p udp -m udp --dport 53 -j X96_GW_DNS'
         echo '-A OUTPUT -p tcp -m tcp --dport 53 -j X96_GW_DNS';;
    mangle) echo "-A OUTPUT -s $tv/32 -o eth0 -j X96_GW_ROUTE";;
    esac
}
chain_name() { if [ "$1" = nat ]; then echo X96_GW_DNS; else echo X96_GW_ROUTE; fi; }
chain_lines() {
    if [ "$1" = nat ]; then
        echo "-A X96_GW_DNS -m mark --mark $probe -j ACCEPT"
        echo "-A X96_GW_DNS -j DNAT --to-destination $2"
    else
        echo "-A X96_GW_ROUTE -m mark --mark $probe -j RETURN"
        for local_dst in "$lan" 224.0.0.0/4 255.255.255.255/32; do
            echo "-A X96_GW_ROUTE -d $local_dst -j RETURN"
        done
        echo "-A X96_GW_ROUTE -j MARK --set-xmark $own"
    fi
}
# Rules other writers own may precede the jumps after an Android network event.
# Keep their relative order. Change only our two named chains and exact hooks.
read_table() { nf "$1" -S; }
rules_for() { awk -v chain="$1" '$1=="-A" && $2==chain'; }
hooks_for() { awk -v chain="$1" '$(NF-1)=="-j" && $NF==chain'; }
nf_ok() (
    t=$1; gw=$2; c=$(chain_name "$t"); snapshot=$(read_table "$t") || exit 1
    expected=$(hook_lines "$t")
    stacked=$(echo "$snapshot" | hooks_for "$c") || exit 1
    [ "$stacked" = "$expected" ] || exit 1
    head_n=$(echo "$expected" | wc -l)
    top=$(echo "$snapshot" | rules_for OUTPUT | head -n "$head_n") || exit 1
    [ "$top" = "$expected" ] && [ "$(echo "$snapshot" | rules_for "$c")" = "$(chain_lines "$t" "$gw")" ]
)
known_nf() (
    t=$1; c=$(chain_name "$t"); snapshot=$(read_table "$t") || exit 1
    allowed="$(hook_lines "$t")
$(chain_lines "$t" "$primary")
$(chain_lines "$t" "$backup")"
    managed=$(echo "$snapshot" | awk -v c="$c" '$1=="-A" && ($2==c || $NF==c)')
    [ -z "$managed" ] && exit 0
    echo "$managed" | while IFS= read -r row; do
        printf '%s\n' "$allowed" | grep -Fqx -- "$row" || exit 1
    done
)
update_nf() (
    t=$1; gw=$2; c=$(chain_name "$t")
    nf_ok "$t" "$gw" && exit 0
    known_nf "$t" || exit 1
    snapshot=$(read_table "$t") || exit 1
    {
        echo "*$t"
        if echo "$snapshot" | grep -Fqx -- "-N $c"; then echo "-F $c"; else echo "-N $c"; fi
        chain_lines "$t" "$gw"
        echo "$snapshot" | hooks_for "$c" | sed 's/^-A /-D /'
        # Reverse insertion order so -S consistently lists UDP, then TCP.
        hook_lines "$t" | awk '{row[NR]=$0} END {for(n=NR;n>0;n--) {sub(/^-A OUTPUT /,"-I OUTPUT 1 ",row[n]);print row[n]}}'
        echo COMMIT
    } | iptables-restore -w 3 --noflush
)
normal() { awk '{$1=$1;print}'; }
rule_text() { echo "$pref: from $tv fwmark $own iif lo lookup $table"; }
owned_rules() {
    awk -v p="$pref:" -v t="$table" '$1==p || ($(NF-1)=="lookup" && $NF==t)' | normal
}
routes_for_table() {
    # Older Android ip prints an empty successful dump for a new table. Recent
    # iproute2 reports ENOENT and exits nonzero before the first route exists.
    output=$(LC_ALL=C ip -4 route show table "$table" 2>&1) && { printf '%s\n' "$output"; return 0; }
    case "$output" in *'FIB table does not exist'*) return 0;; *) return 1;; esac
}
known_ip() (
    all=$(ip -4 rule show) || exit 1
    rules=$(echo "$all" | owned_rules) || exit 1
    [ -z "$rules" ] || [ "$rules" = "$(rule_text)" ] || exit 1
    routes=$(routes_for_table) || exit 1
    # This numeric table is private. Never replace a foreign entry.
    [ -z "$routes" ] && exit 0
    echo "$routes" | normal | while IFS= read -r row; do
        case "$row" in
          "$lan dev eth0 scope link src $tv"|"default via $primary dev eth0"|"default via $backup dev eth0") ;;
          *) exit 1;;
        esac
    done
)
ip_ok() (
    all=$(ip -4 rule show) && routes=$(routes_for_table) || exit 1
    [ "$(echo "$all" | owned_rules)" = "$(rule_text)" ] &&
    echo "$routes" | normal | grep -Fqx -- "$lan dev eth0 scope link src $tv" &&
    echo "$routes" | normal | grep -Fqx -- "default via $1 dev eth0"
)
update_ip() (
    gw=$1
    ip_ok "$gw" && exit 0
    known_ip || exit 1
    ip -4 route replace "$lan" dev eth0 scope link src "$tv" table "$table" &&
    ip -4 route replace default via "$gw" dev eth0 table "$table" || exit 1
    all=$(ip -4 rule show) || exit 1
    if [ -z "$(echo "$all" | owned_rules)" ]; then
        ip -4 rule add pref "$pref" from "$tv/32" fwmark "$own" iif lo lookup "$table" || exit 1
    fi
)
data_ok() (
    gw=$1
    ip_ok "$gw" && nf_ok nat "$gw" && nf_ok mangle "$gw" || exit 1
    ip -4 route get 1.1.1.1 from "$tv" mark 0x20000000 |
        grep -Fq "via $gw dev eth0 table $table" || exit 1
    ip -4 route get 192.168.1.211 from "$tv" mark 0x20000000 |
        grep -Fq "from $tv dev eth0" || exit 1
    ip -4 route get 127.0.0.1 from "$tv" mark 0x20000000 |
        grep -Fq 'dev lo' || exit 1
)
other() { if [ "$1" = "$primary" ]; then echo "$backup"; else echo "$primary"; fi; }
set_plane() {
    update_ip "$1" && update_nf mangle "$1" && update_nf nat "$1" && data_ok "$1" &&
        "$dir/x96-dns-conntrack" purge "$(other "$1")"
}
read_receipt() { cat "$receipt" 2>/dev/null || :; }
prior=$(read_receipt)
if [ "$prior" = "$boot $wanted" ] && data_ok "$wanted"; then exit 0; fi
[ "$action" = apply ] || exit 1
known_ip && known_nf mangle && known_nf nat || { err 'foreign rule/table collision or unreadable state'; exit 1; }
[ -x "$dir/x96-dns-conntrack" ] || { err 'DNS conntrack helper unavailable'; exit 1; }
ip -o -4 addr show dev eth0 | grep -Fq "inet $tv/24 " || { err 'eth0 address pending'; exit 1; }
mkdir -p "${receipt%/*}" || exit 1
# A killed or interrupted operation leaves the last verified receipt intact.
# A retry reconstructs all three components; a first install falls back to
# the configured Android primary if there is no current-boot receipt.
case "$prior" in "$boot $backup") old=$backup;; *) old=$primary;; esac
tmp="$receipt.tmp.$$"
rollback() { rm -f "$tmp"; set_plane "$old" || err "could not completely restore $old"; }
trap 'rollback; exit 1' HUP INT TERM
if set_plane "$wanted" && printf '%s %s\n' "$boot" "$wanted" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$receipt"; then
    trap - HUP INT TERM
    exit 0
fi
trap - HUP INT TERM
err "failed applying $wanted; restoring $old"
rollback
exit 1
