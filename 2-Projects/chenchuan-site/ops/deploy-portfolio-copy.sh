#!/usr/bin/env bash
# Run only on the DNS-verified Korean personal-site instance, after uploading
# an exact source archive plus targets.txt / before.sha256 / after.sha256.
set -Eeuo pipefail
mode=${1:?prepare|activate|rollback|verify}
release=${2:?12-character source commit}
[[ "$release" =~ ^[a-f0-9]{12}$ ]] || exit 2
prod=/var/www/chenchuan-site
incoming=/var/tmp/chenchuan-content-20260914-upload
build=/var/tmp/chenchuan-site-build-$release
backup=/var/www/chenchuan-site-backups/portfolio-copy-20260914-$release
[[ -d "$prod/.next" && -d "$prod/node_modules" ]] || exit 2
cd "$prod"
exec 9>/var/lock/chenchuan-site-content.lock
flock -n 9 || { printf 'Another content deployment is running\n'; exit 3; }

status() {
  pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).find(p=>p.name==="chenchuan-site");const r={name:p?.name,status:p?.pm2_env.status,unstable_restarts:p?.pm2_env.unstable_restarts};console.log(JSON.stringify(r));if(r.status!=="online"||r.unstable_restarts!==0)process.exitCode=1})'
}
exchange() {
  python3 - "$1" "$2" <<'PY'
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
result = libc.renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 2)
if result != 0:
    raise OSError(ctypes.get_errno(), 'atomic directory exchange failed')
PY
}
http_check() {
  local url=$1
  curl -skf --max-time 30 --resolve my.chenchuan.cc:443:127.0.0.1 "$url" -o /dev/null
}
restore() {
  trap - ERR
  set +e
  local errors=0
  cd "$prod"
  node "$backup/deployment/update-video-copy-20260914.cjs" rollback "$prod/data/analytics.db" "$backup/video-live" || errors=1
  tar -xzf "$backup/source.before.tar.gz" -C "$prod" || errors=1
  while IFS= read -r rel; do
    if [[ -f "$prod/$rel" ]]; then
      mkdir -p "$backup/added-files/$(dirname "$rel")"
      mv "$prod/$rel" "$backup/added-files/$rel" || errors=1
    fi
  done < "$backup/absent.txt"
  if [[ -f "$backup/switch-intent" ]] && ! cmp -s "$prod/.next/BUILD_ID" "$backup/next.before/BUILD_ID"; then
    local candidate
    candidate=$(mktemp -d "$prod/.next.rollback-$release.XXXXXX")
    if [[ -n "$candidate" ]] && cp -a "$backup/next.before/." "$candidate/" && exchange "$prod/.next" "$candidate"; then :; else errors=1; fi
  fi
  pm2 restart chenchuan-site > "$backup/pm2-rollback.log" || errors=1
  for attempt in $(seq 1 20); do if http_check https://my.chenchuan.cc/; then break; fi; sleep 1; done
  status || errors=1
  http_check https://my.chenchuan.cc/ || errors=1
  sha256sum -c "$backup/before.sha256" || errors=1
  if [[ "$errors" == 0 ]]; then
    touch "$backup/rolled-back"
    printf 'ROLLED_BACK %s\n' "$backup"
  else printf 'ROLLBACK_INCOMPLETE %s\n' "$backup"; fi
  return "$errors"
}

case "$mode" in
prepare)
  test ! -e "$backup"
  test ! -e "$build"
  test -f "$incoming/site-update.tar.gz"
  while IFS= read -r rel; do
    [[ "$rel" == src/* || "$rel" == scripts/* || "$rel" == ops/* ]] || exit 2
    [[ "$rel" != *..* && "$rel" != *' '* ]] || exit 2
  done < "$incoming/targets.txt"
  python3 - "$incoming/site-update.tar.gz" "$incoming/targets.txt" <<'PY'
import sys, tarfile
with open(sys.argv[2]) as f:
    expected = [line.strip() for line in f if line.strip()]
with tarfile.open(sys.argv[1]) as archive:
    members = archive.getmembers()
    assert all(m.isfile() and not m.name.startswith('/') and '..' not in m.name.split('/') for m in members), 'non-regular or unsafe archive member'
    assert sorted(m.name for m in members) == sorted(expected), 'archive members differ from targets'
PY
  sha256sum -c "$incoming/before.sha256"
  while IFS= read -r rel; do test ! -e "$prod/$rel"; done < "$incoming/before.absent.txt"
  mkdir -m 700 "$backup" "$build"
  mkdir -m 700 "$backup/deployment"
  cp "$incoming/site-update.tar.gz" "$backup/site-update.tar.gz"
  tar -xzf "$backup/site-update.tar.gz" -C "$backup/deployment" --strip-components=1 scripts/update-video-copy-20260914.cjs ops/deploy-portfolio-copy.sh
  cp "$incoming/targets.txt" "$incoming/before.sha256" "$incoming/after.sha256" "$backup/"
  : > "$backup/existing.txt"
  : > "$backup/absent.txt"
  while IFS= read -r rel; do
    if [[ -f "$prod/$rel" ]]; then printf '%s\n' "$rel" >> "$backup/existing.txt"; else printf '%s\n' "$rel" >> "$backup/absent.txt"; fi
  done < "$incoming/targets.txt"
  tar -czf "$backup/source.before.tar.gz" -T "$backup/existing.txt"
  cp -a "$prod/.next" "$backup/next.before"
  status > "$backup/pm2.before.json"
  # A trailing slash only matches directories, not symlinks (production data is a symlink).
  rsync -a --exclude='/.next*' --exclude='/node_modules' --exclude='/data' --exclude='/media' --exclude='/public' --exclude='/.git' --exclude='*.log' "$prod/" "$build/"
  test ! -e "$build/data" && test ! -L "$build/data"
  ln -sT "$prod/node_modules" "$build/node_modules"
  ln -sT "$prod/public" "$build/public"
  mkdir -m 700 "$build/data"
  rsync -a --exclude='/analytics.db*' "$prod/data/" "$build/data/"
  node - "$prod/data/analytics.db" "$build/data/analytics.db" <<'NODE'
const Database=require('better-sqlite3');const db=new Database(process.argv[2],{readonly:true,fileMustExist:true});db.backup(process.argv[3]).then(()=>db.close()).catch(e=>{console.error(e.message);process.exitCode=1;db.close()});
NODE
  tar -xzf "$backup/site-update.tar.gz" -C "$build"
  cd "$build"
  sha256sum -c "$incoming/after.sha256"
  node scripts/update-video-copy-20260914.cjs prepare "$prod/data/analytics.db" "$backup/video-dry-run"
  node scripts/update-video-copy-20260914.cjs apply "$build/data/analytics.db" "$backup/video-stage"
  ANALYTICS_DB_PATH="$build/data/analytics.db" npm run build > "$backup/build.log" 2>&1
  ANALYTICS_DB_PATH="$build/data/analytics.db" node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3101 > "$backup/canary.log" 2>&1 &
  canary_pid=$!
  trap 'kill "$canary_pid" 2>/dev/null || true' EXIT
  for attempt in $(seq 1 30); do
    if curl -sf --max-time 2 http://127.0.0.1:3101/work -o "$backup/canary-work.html"; then break; fi
    sleep 1
  done
  node - "$backup/canary-work.html" <<'NODE'
const fs=require('fs');const html=fs.readFileSync(process.argv[2],'utf8');for(const t of ['KidsHub AI','H 平台','MyJavis','技术：','待合包发布','Bubblewrap'])if(!html.includes(t))throw Error('Missing '+t);for(const t of ['91.5%','四引擎','Gemini','零返工'])if(html.includes(t))throw Error('Stale '+t);console.log('CANARY_COPY_OK');
NODE
  for route in / /about /writing /ai-os/chat /work/h-platform-ai-assistant /work/ai-hardware-voice-prototype /work/myjavis-voice-companion /work/full-window-ar-hud-ai-cockpit /videos; do
    curl -sf --max-time 30 "http://127.0.0.1:3101$route" -o /dev/null
  done
  touch "$backup/prepared"
  printf 'PREPARED %s\n' "$backup"
  ;;
activate)
  test -f "$backup/prepared"
  test ! -e "$backup/switched"
  test ! -e "$backup/rolled-back"
  sha256sum -c "$backup/before.sha256"
  while IFS= read -r rel; do test ! -e "$prod/$rel"; done < "$incoming/before.absent.txt"
  (cd "$build" && sha256sum -c "$backup/after.sha256")
  # Before source changes, all apply inputs are checked and DB has a CAS guard.
  trap 'failure=$?; restore; exit "$failure"' ERR
  node "$build/scripts/update-video-copy-20260914.cjs" apply "$prod/data/analytics.db" "$backup/video-live"
  tar -xzf "$backup/site-update.tar.gz" -C "$prod"
  mv "$build/.next" "$prod/.next.release-$release"
  touch "$backup/switch-intent"
  exchange "$prod/.next" "$prod/.next.release-$release"
  touch "$backup/switched"
  pm2 restart chenchuan-site > "$backup/pm2-activate.log"
  for attempt in $(seq 1 20); do
    if http_check https://my.chenchuan.cc/; then break; fi
    sleep 1
  done
  status | tee "$backup/pm2.after.json"
  http_check https://my.chenchuan.cc/work/h-platform-ai-assistant
  sha256sum -c "$backup/after.sha256"
  node scripts/update-video-copy-20260914.cjs verify "$prod/data/analytics.db" "$backup/video-live"
  trap - ERR
  printf 'ACTIVE %s\n' "$backup"
  ;;
rollback)
  test -f "$backup/prepared"
  restore
  ;;
verify)
  status
  sha256sum -c "$backup/after.sha256"
  node scripts/update-video-copy-20260914.cjs verify "$prod/data/analytics.db" "$backup/video-live"
  http_check https://my.chenchuan.cc/
  http_check https://my.chenchuan.cc/work/h-platform-ai-assistant
  ;;
*) exit 2 ;;
esac
