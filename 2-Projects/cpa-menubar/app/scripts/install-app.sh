#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
"$ROOT/scripts/build-app.sh"
TARGET_APP="/Applications/CPA Menu.app"
NEW_APP="$ROOT/dist/CPA Menu.app"
BACKUP_PARENT="$HOME/Library/Application Support/CPAMenuBar/Backups"
RUN_ID="$(date -u '+%Y%m%d-%H%M%S')-$$"
BACKUP_ROOT="$BACKUP_PARENT/$RUN_ID"
STAGE_ROOT="$(mktemp -d '/Applications/.cpa-menu-install.XXXXXX')"
umask 077
mkdir -p "$BACKUP_ROOT"
codesign --verify --strict "$NEW_APP"
ditto "$NEW_APP" "$STAGE_ROOT/CPA Menu.app"
codesign --verify --strict "$STAGE_ROOT/CPA Menu.app"

if [[ -d "$TARGET_APP" ]]; then
  ditto "$TARGET_APP" "$BACKUP_ROOT/CPA Menu.app"
  shasum -a 256 "$TARGET_APP/Contents/MacOS/CPAMenuBar" | awk '{print $1}' > "$BACKUP_ROOT/binary.sha256"
  install -m 700 "$ROOT/scripts/rollback-app.sh" "$BACKUP_ROOT/rollback-app.sh"
  "$BACKUP_ROOT/rollback-app.sh" --verify-only
fi

python3 - "$BACKUP_ROOT" "$NEW_APP" <<'PY'
import datetime, hashlib, json, plistlib, sys
from pathlib import Path
backup, source = map(Path, sys.argv[1:])
def describe(bundle):
    if not bundle.exists(): return None
    metadata = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    digest = hashlib.sha256((bundle / 'Contents/MacOS/CPAMenuBar').read_bytes()).hexdigest()
    return {'version': metadata['CFBundleShortVersionString'], 'build': metadata['CFBundleVersion'], 'binary_sha256': digest, 'bundle_identifier': metadata['CFBundleIdentifier']}
receipt = {'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'target': '/Applications/CPA Menu.app', 'previous': describe(backup / 'CPA Menu.app'), 'next': describe(source), 'scope': 'app bundle only; no credentials, preferences or server changes', 'status': 'prepared'}
(backup / 'release-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
PY

for process_id in ${(f)"$(pgrep -x CPAMenuBar || true)"}; do
  [[ -n "$process_id" ]] || continue
  command_path="$(ps -p "$process_id" -o comm= 2>/dev/null || true)"
  [[ "$command_path" == "$TARGET_APP/Contents/MacOS/CPAMenuBar" ]] || continue
  kill -TERM "$process_id"
  for attempt in {1..30}; do
    kill -0 "$process_id" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$process_id" 2>/dev/null; then
    echo "installed app did not terminate; installation not applied" >&2
    exit 1
  fi
done

if [[ -e "$TARGET_APP" ]]; then
  mv "$TARGET_APP" "$STAGE_ROOT/previous.app"
fi
if ! mv "$STAGE_ROOT/CPA Menu.app" "$TARGET_APP"; then
  [[ ! -e "$STAGE_ROOT/previous.app" ]] || mv "$STAGE_ROOT/previous.app" "$TARGET_APP"
  open "$TARGET_APP"
  exit 1
fi
if ! codesign --verify --strict "$TARGET_APP" || ! open "$TARGET_APP" --args --show-panel; then
  if [[ -x "$BACKUP_ROOT/rollback-app.sh" ]]; then
    "$BACKUP_ROOT/rollback-app.sh"
  fi
  exit 1
fi
python3 - "$BACKUP_ROOT" "$STAGE_ROOT" <<'PY'
import json, shutil, sys
from pathlib import Path
backup, stage = map(Path, sys.argv[1:])
receipt_path = backup / 'release-receipt.json'
receipt = json.loads(receipt_path.read_text())
receipt['status'] = 'installed; runtime acceptance pending'
receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
assert stage.parent == Path('/Applications') and stage.name.startswith('.cpa-menu-install.')
shutil.rmtree(stage)
PY
echo "installed app: $TARGET_APP"
echo "rollback record: $BACKUP_ROOT/release-receipt.json"
echo "rollback command: $BACKUP_ROOT/rollback-app.sh"
